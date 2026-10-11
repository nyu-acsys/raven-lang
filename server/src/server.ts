import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	//CompletionItemKind,
	//TextDocumentPositionParams,
	TextDocumentSyncKind,
	Range,
	InitializeResult,
	//FileChangeType,
	DocumentDiagnosticReportKind,
	type DocumentDiagnosticReport,
	type DiagnosticRelatedInformation,
	//TextDocumentIdentifier
	WorkDoneProgressBegin,
	WorkDoneProgressEnd,
	ProgressType
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { URI, Utils } from 'vscode-uri';
import { execFile as execCb } from "child_process";
import { promisify } from "node:util";
import { match } from "ts-pattern";
import * as tmp from 'tmp';
import * as fs from "fs";
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);

const documents = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// Which verifier to run, and where to find the z3 it needs. Decided entirely by the
// client -- see client/src/ravenBinary.ts -- because the answer now depends on which
// verifiers the extension has installed, and can change while the server is running.
// The server is told at initialization and again whenever it changes; it never works
// this out for itself.
interface RavenExecutable {
	/** Absolute path, or the bare name `raven` to be found on PATH. */
	executable: string;
	/** Directory to prepend to PATH so Raven finds the bundled z3, if there is one. */
	z3Dir?: string;
	/**
	 * `lsp_protocol` from this executable's `--manifest`, once the client has read it
	 * (see `pushExecutable` in extension.ts). Absent until that arrives, and forever for
	 * a raven too old to answer `--manifest` at all -- both cases must be treated as "do
	 * not rely on anything past protocol 1", the same as an explicit 1.
	 */
	lspProtocol?: number;
}

let ravenExecutable: RavenExecutable = { executable: 'raven' };

/**
 * Resolves once the client has reported the executable's `lsp_protocol` (or that it has
 * none). A check that starts before then waits for it, for a while: otherwise the first
 * check of a document after startup would run as for a protocol-1 raven.
 */
let reportProtocol: () => void = () => { /* replaced below */ };
const protocolReported = new Promise<void>(resolve => { reportProtocol = resolve; });
const PROTOCOL_WAIT_MS = 3000;

/** The executable and protocol the last check ran with, if any. */
let checkedWith: { executable: string, lspProtocol?: number } | undefined;

connection.onNotification('raven/executable', (params: RavenExecutable) => {
	ravenExecutable = params;
	reportProtocol();
	connection.console.log(`Raven executable set to ${params.executable}`);
	// Diagnostics on screen were produced by the previous binary, if it differs. The
	// first report after startup usually only adds the protocol, which checks wait for.
	if (checkedWith !== undefined
		&& (checkedWith.executable !== params.executable || checkedWith.lspProtocol !== params.lspProtocol)) {
		connection.languages.diagnostics.refresh();
	}
});

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	const initOptions = params.initializationOptions as { raven?: RavenExecutable } | undefined;
	if (initOptions?.raven) {
		ravenExecutable = initOptions.raven;
	}

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Full,
			diagnosticProvider: {
				interFileDependencies: false,
				workspaceDiagnostics: false
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	tmp.setGracefulCleanup();
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
	connection.onDidSaveTextDocument(event => {
		//validating handled by pull diagnostics usually, but we can trigger refresh
		connection.languages.diagnostics.refresh();
	});
});

// The settings
// Must match LIBRARY_SCHEME in the client. Declared separately rather than imported
// because client and server are built as independent packages.
const LIBRARY_SCHEME = 'raven-stdlib';

interface ServerSettings {
	strict: boolean;
	maxNumberOfProblems: number;
	highlightRelatedLocations: boolean;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: ServerSettings = { strict: false, maxNumberOfProblems: 1000, highlightRelatedLocations: true };
let globalSettings: ServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ServerSettings>>();

connection.onDidChangeConfiguration(async change => {
	// The settings checks have used so far, to refresh the diagnostics only if they
	// changed: the client also reports the configuration once right after startup.
	const before = await Promise.all([...documentSettings.entries()].map(
		async ([uri, settings]) => [uri, JSON.stringify(await settings)] as const));
	const globalBefore = JSON.stringify(globalSettings);
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ServerSettings>(
			(change.settings.ravenServer || defaultSettings)
		);
	}
	const changed = JSON.stringify(globalSettings) !== globalBefore
		|| (await Promise.all(before.map(async ([uri, settings]) =>
			JSON.stringify(await getDocumentSettings(uri)) !== settings))).some(c => c);
	if (changed) {
		connection.languages.diagnostics.refresh();
	}
});

function getDocumentSettings(resource: string): Thenable<ServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'ravenServer'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

// A manual command can override strict mode for the next check of its document.
const pendingStrictChecks = new Map<string, boolean>();

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	pendingStrictChecks.delete(e.document.uri);
});

// Define progress types for workDoneProgress
const WorkDoneProgressType = new ProgressType<any>();

// Handle manual verification trigger from client
connection.onNotification('raven/verify', (params: { uri: string, strict?: boolean }) => {
	if (params.strict !== undefined) pendingStrictChecks.set(params.uri, params.strict);
	else pendingStrictChecks.delete(params.uri);
	connection.console.log(`Manual verification triggered for ${params.uri}`);
	connection.languages.diagnostics.refresh();
});

/** A location as Raven reports it under --lsp-mode. */
interface RavenLocation {
	file: string, start_line: number, start_col: number, end_line: number, end_col: number,
	library?: boolean, path?: string
}

interface RavenError extends RavenLocation { kind: string, message: string[] }

/**
 * An annotation of --lsp-annotations (protocol 3): the contract a member inherits
 * (`InheritedContract`), or the members a module inherits (`InheritedMembers`).
 */
interface RavenAnnotation extends RavenLocation {
	kind: string,
	source: string,
	source_loc: RavenLocation,
	clauses: (RavenLocation & { keyword: string, text: string })[],
	members: (RavenLocation & { origin: string, text: string })[]
}

/** What the client shows for a module that inherits members. */
interface InheritedMembers {
	range: Range,
	members: { origin: string, text: string, location: { uri: string, range: Range } }[]
}

/** What the client shows for a member that inherits its contract. */
interface InheritedContract {
	range: Range,
	source: string,
	sourceLocation: { uri: string, range: Range },
	clauses: { keyword: string, text: string, location: { uri: string, range: Range }, failing: boolean }[]
}

function locationKey(uri: string, range: Range): string {
	return `${uri}:${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

connection.languages.diagnostics.on(async (params) => {
	// Use workDoneToken for progress reporting if present
	if (params.workDoneToken) {
		connection.sendProgress(WorkDoneProgressType, params.workDoneToken, {
			kind: 'begin',
			title: 'Raven',
			cancellable: false,
			message: 'verifying',
			percentage: 0
		});
	}

	const document = documents.get(params.textDocument.uri);
	let diagnostics: Diagnostic[] = [];
	if (document !== undefined) {
		const strict = pendingStrictChecks.get(document.uri);
		pendingStrictChecks.delete(document.uri);
		diagnostics = await validateTextDocument(document, strict);
	}

	if (params.workDoneToken) {
		connection.sendProgress(WorkDoneProgressType, params.workDoneToken, {
			kind: 'end',
			message: 'done'
		});
	}

	return {
		kind: DocumentDiagnosticReportKind.Full,
		items: diagnostics
	} satisfies DocumentDiagnosticReport;
});

async function validateTextDocument(textDocument: TextDocument, strictOverride?: boolean): Promise<Diagnostic[]> {
	const settings = await getDocumentSettings(textDocument.uri);
	const strict = strictOverride ?? settings.strict;

	// Create temporary file from document
	// Use vscode-uri to get the directory efficiently
	const uri = URI.parse(textDocument.uri);
	const dir = Utils.dirname(uri).fsPath;

	connection.console.log(`raven base dir: ${dir}`);

	const tmpfile = tmp.fileSync({ postfix: ".rav" });
	fs.appendFileSync(tmpfile.fd, textDocument.getText());

	// Call raven and delete tmp
	const execFile = promisify(execCb);

	await Promise.race([protocolReported, new Promise(resolve => setTimeout(resolve, PROTOCOL_WAIT_MS))]);
	const { executable, z3Dir, lspProtocol } = ravenExecutable;
	checkedWith = { executable, lspProtocol };

	// Make the bundled z3 discoverable on PATH -- raven finds z3 via a PATH
	// search when it spawns it, whichever raven is in use.
	const env = z3Dir
		? { ...process.env, PATH: `${z3Dir}${path.delimiter}${process.env.PATH ?? ''}` }
		: process.env;

	// `?? 0`: an unknown protocol (not yet reported, or too old to have one at all) must
	// not get a flag that raven might reject outright -- same as the CLI's own default
	// of `--extension default` when nothing auto-detects it.
	const protocol = lspProtocol ?? 0;
	const argsWith = (extra: string[]) => [
		"--lsp-mode", "-q", ...extra,
		...(strict && protocol >= 3 ? ["--strict"] : []),
		// Protocol 3: Raven also reports annotations, such as inherited contracts.
		...(protocol >= 3 ? ["--lsp-annotations"] : []),
		...(protocol >= 2 ? ["--extension", "auto"] : []),
		"--base-dir", dir, tmpfile.name
	];
	// Runs Raven with the [extra] arguments, reports the inherited contracts it finds to
	// the client, and returns its diagnostics and whether it found errors.
	const check = async (extra: string[]): Promise<{ diagnostics: Diagnostic[], failed: boolean }> => {
		let failed = false;
		const annotations: RavenAnnotation[] = [];

		const diagnostics: Diagnostic[] = [];

		try {
			// connection.console.log(`Executing: ${executable} ${args.join(" ")}`);
			const { stdout } = await execFile(executable, argsWith(extra), { cwd: dir, env });

			connection.console.log(`Raven response: ${stdout}`);

			// No output = no problems found (and, before protocol 3, no annotations)
			if (stdout == "") {
				connection.sendNotification('raven/inheritedContracts', { uri: textDocument.uri, contracts: [], modules: [] });
				return { diagnostics, failed };
			}

			// Parse non-empty output
			const parse = function (stdout: any) {
				try {
					return JSON.parse(stdout);
				} catch (e) {
					// Report internal error if output is invalid
					return [{ kind: "Internal", file: tmpfile.name, message: ["Failed to parse output of Raven"], start_line: 1, start_col: 0, end_line: 1, end_col: 0 }];
				}
			}

			// With --lsp-annotations, an object with the errors and the annotations;
			// otherwise just the errors.
			const output = parse(stdout);
			const errors: RavenError[] = Array.isArray(output) ? output : (output.errors ?? []);
			if (!Array.isArray(output)) {
				annotations.push(...(output.annotations ?? []));
			}
			failed = errors.some(e => e.kind !== "RelatedLoc" && e.kind !== "Warning");

			// Raven reports every location in whatever file it is really in: the temporary
			// copy of this document, a file reached through `include`, or one of its own
			// embedded library sources. Only the temp copy needs rewriting -- everything else
			// is a real location already, and passing it through is what makes a related
			// location clickable rather than silently redirected at the file being edited.
			//
			// A library source is flagged `library` and named by its path within the Raven
			// repository. It carries `path` as well when the verifier is running inside a
			// checkout whose copy of that file matches the embedded one byte for byte -- the
			// real source, worth opening and editing. Otherwise there is no file to open and
			// we fall back to the read-only virtual document (see LIBRARY_SCHEME in the
			// client), which serves the text from the verifier itself.
			const tmpfileResolved = path.resolve(tmpfile.name);
			const uriForError = function (e: { file: string, library?: boolean, path?: string }): string {
				if (e.library) {
					return e.path
						? URI.file(e.path).toString()
						: URI.from({ scheme: LIBRARY_SCHEME, path: `/${e.file}` }).toString();
				}
				const resolved = path.resolve(dir, e.file);
				return resolved === tmpfileResolved ? textDocument.uri : URI.file(resolved).toString();
			};

			const rangeOf = function (e: { start_line: number, start_col: number, end_line: number, end_col: number }) {
				return {
					start: { line: Math.max(0, e.start_line - 1), character: Math.max(0, e.start_col) },
					end: { line: Math.max(0, e.end_line - 1), character: Math.max(0, e.end_col) }
				};
			};

			// A related location may be reported either before or after the diagnostic it
			// explains -- Raven prints the declaration a rule was inherited from ahead of the
			// failure, and the unproven assertion after it. Leading ones used to be dropped
			// outright (`diagnostics.pop()` on an empty array), so buffer them and attach
			// them to the next error instead.
			let pendingRelated: DiagnosticRelatedInformation[] = [];
			let previousError: Diagnostic | undefined;

			// Underlines for related locations that fall inside this document, collected
			// separately so they are appended after the errors they explain.
			const highlightRelated = settings.highlightRelatedLocations !== false;
			const relatedHighlights: Diagnostic[] = [];

			// Convert errors into diagnostic reports
			for (const err of errors) {
				const kind_string = match(err)
					.returnType<string>()
					.with({ kind: 'Lexical' }, () => 'Lexical Error')
					.with({ kind: 'Syntax' }, () => 'Syntax Error')
					.with({ kind: 'Type' }, () => 'Type Error')
					.with({ kind: 'Verification' }, () => 'Verification Error')
					.with({ kind: 'Internal' }, () => 'Internal Error')
					.with({ kind: 'Unsupported' }, () => 'Unsupported Error')
					.with({ kind: 'RelatedLoc' }, () => 'Related Location')
					.with({ kind: 'Warning' }, () => 'Warning')
					.otherwise(() => "Error");

				const msg = err.message.join("\n");

				if (err.kind == "RelatedLoc") {
					if (hasDiagnosticRelatedInformationCapability) {
						const uri = uriForError(err);
						const related: DiagnosticRelatedInformation = {
							location: { uri, range: rangeOf(err) },
							message: `${msg}`
						};
						if (previousError) {
							previousError.relatedInformation = [...(previousError.relatedInformation ?? []), related];
						} else {
							pendingRelated.push(related);
						}
						// Related information alone is only visible on hover or in the Problems
						// panel. Emitting the location as a diagnostic in its own right also
						// underlines it in the editor -- Information severity, so it is blue
						// rather than the red of the failure it explains. Only for locations in
						// this document: a diagnostic is displayed in the document it is
						// reported against, so one belonging to another file has to stay
						// related information.
						if (highlightRelated && uri === textDocument.uri) {
							relatedHighlights.push({
								severity: DiagnosticSeverity.Information,
								range: rangeOf(err),
								message: `[Related Location] ${msg}`,
								source: 'raven'
							});
						}
					}
				} else {
					const diagnostic: Diagnostic = {
						severity: err.kind === "Warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
						...(err.kind === "Warning" ? { code: "strict" } : {}),
						range: rangeOf(err),
						message: `[${kind_string}] ${msg}`,
						source: 'raven'
					};
					// Warnings do not change the error that related locations explain.
					if (err.kind !== "Warning") {
						previousError = diagnostic;
						if (pendingRelated.length > 0) {
							diagnostic.relatedInformation = pendingRelated;
							pendingRelated = [];
						}
					}
					diagnostics.push(diagnostic);
				}
			}

			diagnostics.push(...relatedHighlights);

			// The contracts that members of this document inherit, for the client to show
			// under their headers. A clause is marked as failing when an error names it as a
			// related location.
			const failing = new Set(errors
				.filter(e => e.kind === "RelatedLoc")
				.map(e => locationKey(uriForError(e), rangeOf(e))));
			const contracts: InheritedContract[] = annotations
				.filter(a => a.kind === "InheritedContract" && uriForError(a) === textDocument.uri)
				.map(a => ({
					range: rangeOf(a),
					source: a.source,
					sourceLocation: { uri: uriForError(a.source_loc), range: rangeOf(a.source_loc) },
					clauses: a.clauses.map(c => {
						const location = { uri: uriForError(c), range: rangeOf(c) };
						return {
							keyword: c.keyword,
							text: c.text,
							location,
							failing: failing.has(locationKey(location.uri, location.range))
						};
					})
				}));
		const modules: InheritedMembers[] = annotations
			.filter(a => a.kind === "InheritedMembers" && uriForError(a) === textDocument.uri)
			.map(a => ({
				range: rangeOf(a),
				members: a.members.map(m => ({
					origin: m.origin,
					text: m.text,
					location: { uri: uriForError(m), range: rangeOf(m) }
				}))
			}));
		connection.sendNotification('raven/inheritedContracts', { uri: textDocument.uri, contracts, modules });
		} catch (error: any) {
			connection.console.error(`Error executing Raven: ${error.message}`);
			connection.sendNotification('raven/inheritedContracts', { uri: textDocument.uri, contracts: [], modules: [] });
			// Optionally report a diagnostic if Raven fails to run
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 }
				},
				message: `Failed to execute the Raven verifier at '${executable}'. Error: ${error.message}`,
				source: 'raven'
			};
			diagnostics.push(diagnostic);
		}
		return { diagnostics, failed };
	};

	try {
		// Type checking alone gives the inherited contracts, much sooner than verification.
		// Its errors are already the complete result; otherwise, verification follows.
		if (protocol >= 3) {
			const typed = await check(["--typeonly"]);
			if (typed.failed) {
				return typed.diagnostics;
			}
		}
		const result = (await check([])).diagnostics;
		if (strict && protocol < 3) {
			result.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				message: 'Strict-mode diagnostics require a newer Raven verifier (LSP protocol 3 or later). Update the verifier to enable them.',
				source: 'raven'
			});
		}
		return result;
	} finally {
		tmpfile.removeCallback();
	}
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received a file change event');
});

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		if (item.data === 1) {
			item.detail = 'TypeScript details';
			item.documentation = 'TypeScript documentation';
		} else if (item.data === 2) {
			item.detail = 'JavaScript details';
			item.documentation = 'JavaScript documentation';
		}
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();

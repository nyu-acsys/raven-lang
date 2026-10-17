import {
	createConnection,
	ResponseError,
	LSPErrorCodes,
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
import { VerificationProcesses } from './verificationProcesses';
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

/** Initial protocol discovery need not restart a check still waiting for it. */
let hasStartedChecking = false;

connection.onNotification('raven/executable', (params: RavenExecutable) => {
	const executableChanged = ravenExecutable.executable !== params.executable || ravenExecutable.z3Dir !== params.z3Dir;
	const changed = executableChanged || ravenExecutable.lspProtocol !== params.lspProtocol;
	ravenExecutable = params;
	if (executableChanged || (changed && hasStartedChecking)) {
		pendingStrictChecks.clear();
		completedResults.clear();
		cancelAllRuns();
	}
	reportProtocol();
	connection.console.log(`Raven executable set to ${params.executable}`);
	// Diagnostics on screen were produced by the previous binary, if it differs. The
	// first report after startup usually only adds the protocol, which checks wait for.
	if (hasStartedChecking && changed) {
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
				interFileDependencies: true,
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
	connection.onDidSaveTextDocument(event => invalidateDependents([event.textDocument.uri]));
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
const defaultSettings: ServerSettings = { strict: false, maxNumberOfProblems: 100, highlightRelatedLocations: true };
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
		globalSettings = (change.settings.ravenServer || defaultSettings) as ServerSettings;
	}
	const changed = JSON.stringify(globalSettings) !== globalBefore
		|| (await Promise.all(before.map(async ([uri, settings]) =>
			JSON.stringify(await getDocumentSettings(uri)) !== settings))).some(c => c);
	if (changed) {
		pendingStrictChecks.clear();
		completedResults.clear();
		cancelAllRuns();
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

// Keep a manual override through diagnostic retries until its check completes.
const pendingStrictChecks = new Map<string, boolean>();
interface VerificationRun { id: number, controller: AbortController, retriggerRequest: boolean, changedFiles: Set<string> }
const activeRuns = new Map<string, VerificationRun>();
const documentDependencies = new Map<string, Set<string>>();
const completedResults = new Map<string, { version: number, resultId: string }>();

function invalidateDependents(changed: string[]): void {
	if (changed.length === 0) return;
	for (const run of activeRuns.values()) changed.forEach(uri => run.changedFiles.add(uri));
	const affected = documents.all().filter(document => {
		const dependencies = documentDependencies.get(document.uri);
		// Older verifiers and checks still discovering their includes need a conservative refresh.
		return dependencies === undefined || changed.some(uri => dependencies.has(uri));
	});
	for (const document of affected) {
		pendingStrictChecks.delete(document.uri);
		completedResults.delete(document.uri);
		cancelRun(document.uri);
		connection.sendNotification('raven/verificationInvalidated', {
			uri: document.uri, version: document.version, runId: nextRunId
		});
	}
	if (affected.length > 0) connection.languages.diagnostics.refresh();
}
const verificationProcesses = new VerificationProcesses();
function cancelRun(uri: string, retriggerRequest = true): void {
	const run = activeRuns.get(uri);
	activeRuns.delete(uri);
	if (run) {
		run.retriggerRequest = retriggerRequest;
		run.controller.abort();
	}
}
function cancelAllRuns(retriggerRequest = true): void {
	for (const uri of activeRuns.keys()) cancelRun(uri, retriggerRequest);
}
connection.onShutdown(async () => {
	cancelAllRuns(false);
	await verificationProcesses.waitForIdle();
});
connection.onExit(() => cancelAllRuns(false));
process.on('exit', () => cancelAllRuns(false));
documents.onDidChangeContent(e => {
	pendingStrictChecks.delete(e.document.uri);
	completedResults.delete(e.document.uri);
	cancelRun(e.document.uri);
});
let nextRunId = 0;

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	documentDependencies.delete(e.document.uri);
	completedResults.delete(e.document.uri);
	pendingStrictChecks.delete(e.document.uri);
	cancelRun(e.document.uri, false);
});

// Define progress types for workDoneProgress
const WorkDoneProgressType = new ProgressType<WorkDoneProgressBegin | WorkDoneProgressEnd>();

// Handle manual verification trigger from client
connection.onNotification('raven/verify', (params: { uri: string, strict?: boolean }) => {
	if (params.strict !== undefined) pendingStrictChecks.set(params.uri, params.strict);
	else pendingStrictChecks.delete(params.uri);
	completedResults.delete(params.uri);
	cancelRun(params.uri);
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

type CompletedState = 'succeeded' | 'warnings' | 'failed' | 'unavailable';
interface VerificationResult { diagnostics: Diagnostic[], state: CompletedState, message?: string }
interface CheckResult { diagnostics: Diagnostic[], failed: boolean, unavailable?: string }

connection.languages.diagnostics.on(async (params, token) => {
	const document = documents.get(params.textDocument.uri);
	if (!document) return { kind: DocumentDiagnosticReportKind.Full, items: [] } satisfies DocumentDiagnosticReport;

	const cached = completedResults.get(document.uri);
	if (!pendingStrictChecks.has(document.uri) && cached?.version === document.version && params.previousResultId === cached.resultId) {
		return { kind: DocumentDiagnosticReportKind.Unchanged, resultId: cached.resultId } satisfies DocumentDiagnosticReport;
	}
	completedResults.delete(document.uri);
	const snapshot = TextDocument.create(document.uri, document.languageId, document.version, document.getText());
	const runId = ++nextRunId;
	cancelRun(snapshot.uri, false);
	const controller = new AbortController();
	const run: VerificationRun = { id: runId, controller, retriggerRequest: true, changedFiles: new Set() };
	activeRuns.set(snapshot.uri, run);
	const cancellation = token.onCancellationRequested(() => cancelRunIfCurrent());
	function cancelRunIfCurrent(): void {
		if (activeRuns.get(snapshot.uri)?.id === runId) cancelRun(snapshot.uri, false);
	}
	if (token.isCancellationRequested) cancelRunIfCurrent();
	const isCurrent = () => activeRuns.get(snapshot.uri)?.id === runId
		&& documents.get(snapshot.uri)?.version === snapshot.version && !token.isCancellationRequested;
	const reportState = (state: 'running' | CompletedState, message?: string) => {
		if (isCurrent()) connection.sendNotification('raven/verificationState', {
			uri: snapshot.uri, version: snapshot.version, runId, state, message
		});
	};
	const reportDependencies = (dependencies: string[] | undefined) => {
		if (!isCurrent()) return;
		if (dependencies) documentDependencies.set(snapshot.uri, new Set(dependencies));
		else documentDependencies.delete(snapshot.uri);
		const changed = dependencies?.filter(uri => run.changedFiles.has(uri)) ?? [];
		if (changed.length > 0) { invalidateDependents(changed); return; }
		connection.sendNotification('raven/dependencies', {
			uri: snapshot.uri, version: snapshot.version, runId, dependencies: dependencies ?? []
		});
	};
	const strict = pendingStrictChecks.get(snapshot.uri);
	reportState('running');
	if (params.workDoneToken) connection.sendProgress(WorkDoneProgressType, params.workDoneToken, {
		kind: 'begin', title: 'Raven', cancellable: false, message: 'verifying', percentage: 0
	});
	try {
		const result = await validateTextDocument(
			snapshot, strict, isCurrent, controller.signal, reportDependencies, runId);
		if (!isCurrent()) throw new ResponseError(LSPErrorCodes.ServerCancelled, 'Verification superseded', { retriggerRequest: true });
		reportState(result.state, result.message);
		const resultId = String(runId);
		pendingStrictChecks.delete(snapshot.uri);
		if (result.state !== 'unavailable') completedResults.set(snapshot.uri, { version: snapshot.version, resultId });
		return { kind: DocumentDiagnosticReportKind.Full, resultId, items: result.diagnostics } satisfies DocumentDiagnosticReport;
	} catch (error) {
		if (!isCurrent()) throw new ResponseError(
			token.isCancellationRequested ? LSPErrorCodes.RequestCancelled : LSPErrorCodes.ServerCancelled,
			'Verification superseded', { retriggerRequest: run.retriggerRequest && documents.get(snapshot.uri) !== undefined });
		reportState('unavailable', String(error));
		throw error;
	} finally {
		cancellation.dispose();
		if (activeRuns.get(snapshot.uri)?.id === runId) activeRuns.delete(snapshot.uri);
		if (params.workDoneToken) connection.sendProgress(WorkDoneProgressType, params.workDoneToken, { kind: 'end', message: 'done' });
	}
});

async function validateTextDocument(
	textDocument: TextDocument,
	strictOverride: boolean | undefined,
	isCurrent: () => boolean,
	signal: AbortSignal,
	reportDependencies: (dependencies: string[] | undefined) => void,
	runId: number
): Promise<VerificationResult> {
	const settings = await getDocumentSettings(textDocument.uri);
	const strict = strictOverride ?? settings.strict;
	const reportAnnotations = (contracts: InheritedContract[], modules: InheritedMembers[]) => {
		if (isCurrent()) connection.sendNotification('raven/inheritedContracts', {
			uri: textDocument.uri, version: textDocument.version, runId, contracts, modules
		});
	};
	const resultFor = (result: CheckResult): VerificationResult => ({
		diagnostics: result.diagnostics,
		state: result.unavailable !== undefined ? 'unavailable' : result.failed ? 'failed'
			: result.diagnostics.some(d => d.code === 'strict') ? 'warnings' : 'succeeded',
		message: result.unavailable
	});

	if (!isCurrent()) throw new Error('Verification superseded');

	// Create temporary file from document
	// Use vscode-uri to get the directory efficiently
	const uri = URI.parse(textDocument.uri);
	const dir = Utils.dirname(uri).fsPath;

	connection.console.log(`raven base dir: ${dir}`);

	await Promise.race([protocolReported, new Promise(resolve => setTimeout(resolve, PROTOCOL_WAIT_MS))]);
	if (!isCurrent()) throw new Error('Verification superseded');
	const tmpfile = tmp.fileSync({ postfix: ".rav" });
	fs.appendFileSync(tmpfile.fd, textDocument.getText());
	const { executable, z3Dir, lspProtocol } = ravenExecutable;
	hasStartedChecking = true;

	// Make the bundled z3 discoverable on PATH -- raven finds z3 via a PATH
	// search when it spawns it, whichever raven is in use.
	const env = z3Dir
		? { ...process.env, PATH: `${z3Dir}${path.delimiter}${process.env.PATH ?? ''}` }
		: process.env;

	// `?? 0`: an unknown protocol (not yet reported, or too old to have one at all) must
	// not get a flag that raven might reject outright -- same as the CLI's own default
	// of `--extension default` when nothing auto-detects it.
	const protocol = lspProtocol ?? 0;
	// Protocol 4: Raven stops after this many errors; 0 means no limit. Without the flag, it
	// has no limit under --lsp-mode.
	const maxErrors = settings.maxNumberOfProblems;
	const maxErrorsArgs = protocol >= 4 && Number.isInteger(maxErrors) && maxErrors >= 0
		? ["--max-errors", String(maxErrors)] : [];
	const argsWith = (extra: string[]) => [
		"--lsp-mode", "-q", ...extra,
		...(strict && protocol >= 3 ? ["--strict"] : []),
		// Protocol 3: Raven also reports annotations, such as inherited contracts.
		...(protocol >= 3 ? ["--lsp-annotations"] : []),
		...(protocol >= 2 ? ["--extension", "auto"] : []),
		...maxErrorsArgs,
		"--base-dir", dir, tmpfile.name
	];
	// Runs Raven with the [extra] arguments, reports the inherited contracts it finds to
	// the client, and returns its diagnostics and whether it found errors.
	const check = async (extra: string[]): Promise<CheckResult> => {
		let failed = false;
		let unavailable: string | undefined;
		const annotations: RavenAnnotation[] = [];

		const diagnostics: Diagnostic[] = [];

		try {
			const stdout = await verificationProcesses.run(executable, argsWith(extra), { cwd: dir, env }, signal);

			connection.console.log(`Raven response: ${stdout}`);

			// No output = no problems found (and, before protocol 3, no annotations)
			if (stdout == "") {
				if (protocol >= 3) throw new Error('Empty diagnostic response from Raven');
				reportDependencies(undefined);
				reportAnnotations([], []);
				return { diagnostics, failed };
			}

			const output = JSON.parse(stdout);
			const errors: RavenError[] = Array.isArray(output) ? output : output.errors;
			if (!Array.isArray(errors) || errors.some(e => typeof e.kind !== 'string'
				|| typeof e.file !== 'string' || !Array.isArray(e.message)
				|| !e.message.every(m => typeof m === 'string')
				|| ![e.start_line, e.start_col, e.end_line, e.end_col].every(Number.isInteger))) {
				throw new Error('Invalid diagnostic response from Raven');
			}
			const dependencies = Array.isArray(output) ? undefined : output.dependencies;
			if (dependencies !== undefined && (!Array.isArray(dependencies) || dependencies.some(file => typeof file !== 'string'))) {
				throw new Error('Invalid dependency response from Raven');
			}
			reportDependencies(dependencies?.map((file: string) => URI.file(path.resolve(dir, file)).toString()));
			if (!Array.isArray(output)) annotations.push(...(output.annotations ?? []));
			failed = errors.some(e => e.kind !== "RelatedLoc" && e.kind !== "Warning" && e.kind !== "Limit");

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

				if (err.kind === "Limit") {
					// Protocol 4: Raven stopped after the maximal number of errors.
					diagnostics.push({
						severity: DiagnosticSeverity.Information,
						range: rangeOf(err),
						message: `Raven stopped after ${maxErrors} errors; increase ravenServer.maxNumberOfProblems to see more.`,
						source: 'raven'
					});
				} else if (err.kind == "RelatedLoc") {
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
		reportAnnotations(contracts, modules);
		} catch (error) {
			if (signal.aborted) throw error;
			unavailable = error instanceof Error ? error.message : String(error);
			failed = true;
			connection.console.error(`Error executing Raven: ${unavailable}`);
			reportAnnotations([], []);
			// Optionally report a diagnostic if Raven fails to run
			const diagnostic: Diagnostic = {
				severity: DiagnosticSeverity.Warning,
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 0 }
				},
				message: `Could not complete Raven verification using '${executable}': ${unavailable}`,
				source: 'raven'
			};
			diagnostics.push(diagnostic);
		}
		return { diagnostics, failed, unavailable };
	};

	try {
		// Type checking alone gives the inherited contracts, much sooner than verification.
		// Its errors are already the complete result; otherwise, verification follows.
		if (protocol >= 3) {
			const typed = await check(["--typeonly"]);
			if (typed.failed) {
				return resultFor(typed);
			}
		}
		if (!isCurrent()) throw new ResponseError(LSPErrorCodes.ServerCancelled, 'Verification superseded', { retriggerRequest: true });
		const result = resultFor(await check([]));
		if (strict && protocol < 3) {
			result.state = 'unavailable';
			result.message = 'Strict-mode diagnostics require a Raven verifier supporting LSP protocol 3 or later.';
			result.diagnostics.push({
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

connection.onDidChangeWatchedFiles(change => invalidateDependents(change.changes.map(event => event.uri)));

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

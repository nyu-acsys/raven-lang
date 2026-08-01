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

// Directory bundled alongside the extension containing platform-specific
// `raven`/`z3` binaries. Set via initializationOptions by the client; empty
// when running from source or an unbundled build (e.g. during development).
let bundledBinDir = '';

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	const initOptions = params.initializationOptions as { bundledBinDir?: string } | undefined;
	bundledBinDir = initOptions?.bundledBinDir ?? '';

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
	maxNumberOfProblems: number;
	executablePath: string;
	highlightRelatedLocations: boolean;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: ServerSettings = { maxNumberOfProblems: 1000, executablePath: '', highlightRelatedLocations: true };
let globalSettings: ServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ServerSettings>>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ServerSettings>(
			(change.settings.ravenServer || defaultSettings)
		);
	}
	// Refresh the diagnostics since the settings could have changed.
	connection.languages.diagnostics.refresh();
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

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// Define progress types for workDoneProgress
const WorkDoneProgressType = new ProgressType<any>();

// Handle manual verification trigger from client
connection.onNotification('raven/verify', (params: { uri: string }) => {
	connection.console.log(`Manual verification triggered for ${params.uri}`);
	connection.languages.diagnostics.refresh();
});

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
		diagnostics = await validateTextDocument(document);
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

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	const settings = await getDocumentSettings(textDocument.uri);

	// Create temporary file from document
	// Use vscode-uri to get the directory efficiently
	const uri = URI.parse(textDocument.uri);
	const dir = Utils.dirname(uri).fsPath;

	connection.console.log(`raven base dir: ${dir}`);

	const tmpfile = tmp.fileSync({ postfix: ".rav" });
	fs.appendFileSync(tmpfile.fd, textDocument.getText());

	// Call raven and delete tmp
	const execFile = promisify(execCb);

	// An explicit `ravenServer.executablePath` always wins (dev-build override).
	// Otherwise fall back to the binary bundled with the extension, if any.
	const bundledExecutable = bundledBinDir
		? path.join(bundledBinDir, process.platform === 'win32' ? 'raven.exe' : 'raven')
		: undefined;
	const executable = settings.executablePath || bundledExecutable || 'raven';

	// Make the bundled z3 discoverable on PATH -- raven finds z3 via a PATH
	// search when it spawns it, whether raven itself is the bundled binary or
	// a locally-built dev copy.
	const env = bundledBinDir
		? { ...process.env, PATH: `${bundledBinDir}${path.delimiter}${process.env.PATH ?? ''}` }
		: process.env;

	const diagnostics: Diagnostic[] = [];

	try {
		// connection.console.log(`Executing: ${executable} --lsp-mode -q --base-dir ${dir} ${tmpfile.name}`);
		const { stdout } = await execFile(executable, ["--lsp-mode", "-q", "--base-dir", dir, tmpfile.name], { cwd: dir, env });

		connection.console.log(`Raven response: ${stdout}`);

		// No output = no problems found
		if (stdout == "") {
			return diagnostics;
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

		const errors: { kind: string, file: string, message: string[], start_line: number, start_col: number, end_line: number, end_col: number, library?: boolean, path?: string }[] =
			parse(stdout);

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
		// them to the next diagnostic instead.
		let pendingRelated: DiagnosticRelatedInformation[] = [];

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
				.otherwise(() => "Error");

			const msg = err.message.join("\n");

			if (err.kind == "RelatedLoc") {
				if (hasDiagnosticRelatedInformationCapability) {
					const uri = uriForError(err);
					const related: DiagnosticRelatedInformation = {
						location: { uri, range: rangeOf(err) },
						message: `${msg}`
					};
					const previous = diagnostics[diagnostics.length - 1];
					if (previous) {
						previous.relatedInformation = [...(previous.relatedInformation ?? []), related];
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
					severity: DiagnosticSeverity.Error,
					range: rangeOf(err),
					message: `[${kind_string}] ${msg}`,
					source: 'raven'
				};
				if (pendingRelated.length > 0) {
					diagnostic.relatedInformation = pendingRelated;
					pendingRelated = [];
				}
				diagnostics.push(diagnostic);
			}
		}

		diagnostics.push(...relatedHighlights);
	} catch (error: any) {
		connection.console.error(`Error executing Raven: ${error.message}`);
		// Optionally report a diagnostic if Raven fails to run
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: {
				start: { line: 0, character: 0 },
				end: { line: 0, character: 0 }
			},
			message: `Failed to execute Raven verifier. Please check 'ravenServer.executablePath'. Error: ${error.message}`,
			source: 'raven'
		};
		diagnostics.push(diagnostic);
	} finally {
		tmpfile.removeCallback();
	}

	return diagnostics;
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

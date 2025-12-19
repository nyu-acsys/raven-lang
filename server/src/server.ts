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

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

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
interface ServerSettings {
	maxNumberOfProblems: number;
	executablePath: string;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
const defaultSettings: ServerSettings = { maxNumberOfProblems: 1000, executablePath: 'raven' };
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

	// Use configured executable path
	const executable = settings.executablePath || 'raven';

	const diagnostics: Diagnostic[] = [];

	try {
		// connection.console.log(`Executing: ${executable} --lsp-mode -q --base-dir ${dir} ${tmpfile.name}`);
		const { stdout } = await execFile(executable, ["--lsp-mode", "-q", "--base-dir", dir, tmpfile.name], { cwd: dir });

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

		const errors: { kind: string, file: string, message: string[], start_line: number, start_col: number, end_line: number, end_col: number }[] =
			parse(stdout);

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
					const diagnostic = diagnostics.pop();
					if (diagnostic) {
						const related = {
							location: {
								uri: textDocument.uri,
								range: {
									start: { line: Math.max(0, err.start_line - 1), character: Math.max(0, err.start_col) },
									end: { line: Math.max(0, err.end_line - 1), character: Math.max(0, err.end_col) }
								},
							},
							message: `${msg}`,
							source: 'raven'
						};
						if (!diagnostic.relatedInformation) {
							diagnostic.relatedInformation = [related];
						} else {
							diagnostic.relatedInformation.push(related);
						}
						diagnostics.push(diagnostic);
					}
				}
			} else {
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: {
						start: { line: Math.max(0, err.start_line - 1), character: Math.max(0, err.start_col) },
						end: { line: Math.max(0, err.end_line - 1), character: Math.max(0, err.end_col) }
					},
					message: `[${kind_string}] ${msg}`,
					source: 'raven'
				};
				diagnostics.push(diagnostic);
			}
		}
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

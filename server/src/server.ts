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
	WorkDoneProgressEnd
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { execFile as execCb } from "child_process";
import { promisify } from "node:util";
import { match } from "ts-pattern";
import * as tmp from 'tmp';
import * as fs from "fs";

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
			// Tell the client that this server supports code completion.
			//completionProvider: {
			//	resolveProvider: true
			//},
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
		//validateTextDocument(event.textDocument);
		connection.languages.diagnostics.refresh();
		console.log('Received save event ' + event.textDocument.uri);
	});
});

// The settings
interface ServerSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ServerSettings = { maxNumberOfProblems: 1000 };
// eslint-disable-next-line @typescript-eslint/no-unused-vars 
let globalSettings: ServerSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ServerSettings>>();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = (
			(change.settings.languageServerExample || defaultSettings)
		);
	}
	// Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
	// We could optimize things here and re-fetch the setting first can compare it
	// to the existing setting, but this is out of scope for this example.
	connection.languages.diagnostics.refresh();
});

/*function getDocumentSettings(resource: string): Thenable<ServerSettings> {
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
}*/

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
	const document = documents.get(params.textDocument.uri);
	if (document !== undefined) {
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: await validateTextDocument(document)
		} satisfies DocumentDiagnosticReport;
	} else {
		// We don't know the document. We can either try to read it from disk
		// or we don't report problems for it.
		return {
			kind: DocumentDiagnosticReportKind.Full,
			items: []
		} satisfies DocumentDiagnosticReport;
	}
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
/*documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});*/

async function validateTextDocument(textDocument: TextDocument): Promise<Diagnostic[]> {
	// Register progress notification
  const progress = await connection.window.createWorkDoneProgress();
	progress.begin('Raven', 0, 'verifying', true);

	// Create temporary file from document
	const file = URI.parse(textDocument.uri).path;
	const path = file.slice(0, file.lastIndexOf('/'));
	console.log(`raven ${path}`);	
	const tmpfile = tmp.fileSync({postfix: ".rav"});
	fs.appendFileSync(tmpfile.fd, textDocument.getText());

	// Call raven and delete tmp
	const execFile = promisify(execCb);
	console.log(process.env.PATH);
	const {stdout} = await execFile("raven", ["--lsp-mode", "-q", "--base-dir", path, tmpfile.name], { cwd: path, env: process.env });
	
	tmpfile.removeCallback();
	console.log(`Raven response: ${stdout}`);
	
	// Signal to client that we are done
	progress.done();

	// Start raven output analysis
	const diagnostics: Diagnostic[] = [];

	// No output = no problems foudn
	if (stdout == "") { return diagnostics; }

	// Parse non-empty output
	const parse = function(stdout: any) {
		try {
			return JSON.parse(stdout);
		} catch (e) {
			// Report internal error if output is invalid
			return [{kind: "Internal", file: tmpfile.name, message: "Failed to parse output of Raven", start_line: 0, start_col: 0, end_line: 0, end_col: 0}];
		}
	}
	
	const errors: {kind: string, file: string, message: string[], start_line: number, start_col: number, end_line: number, end_col: number}[] = 
	  parse(stdout);

	// Convert errors into diagnostic reports
	for(const err of errors) {
		console.log(err);
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

		console.log(err.message);
		const msg = err.message.join("\n");
		
		if (err.kind == "RelatedLoc") {
			console.log("adding related loc");
			if (hasDiagnosticRelatedInformationCapability) {
				const diagnostic = diagnostics.pop();
			  if (diagnostic) { 
					const related = {
						location: {
  					  uri: textDocument.uri,
						  range: {
							  start: { line: err.start_line - 1, character: err.start_col}, //textDocument.positionAt(err.range_start),
							  end: { line: err.end_line - 1, character: err.end_col }
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
					start: { line: err.start_line - 1, character: err.start_col}, //textDocument.positionAt(err.range_start),
					end: { line: err.end_line - 1, character: err.end_col }
				},
				message: `[${kind_string}] ${msg}`,
				source: 'raven'
			};
			diagnostics.push(diagnostic);
		}
		
	}

	return diagnostics;
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	console.log('We received a file change event');
});

connection.onDidSaveTextDocument((document) => {
	console.log('We received a save event ' + document.textDocument.uri);
});



// This handler provides the initial list of the completion items.
/*connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		// The pass parameter contains the position of the text document in
		// which code complete got requested. For the example we ignore this
		// info and always provide the same completion items.
		return [
			{
				label: 'TypeScript',
				kind: CompletionItemKind.Text,
				data: 1
			},
			{
				label: 'JavaScript',
				kind: CompletionItemKind.Text,
				data: 2
			}
		];
	}
);*/

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

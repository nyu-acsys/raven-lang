/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { ProgressType } from 'vscode-languageclient';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;
let verificationStatusBarItem: vscode.StatusBarItem;

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: debugOptions
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'raven' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'ravenServer',
		'Raven LSP',
		serverOptions,
		clientOptions
	);

	// Create the status bar item
	verificationStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationStatusBarItem.text = '$(check) Verification Successful';
	verificationStatusBarItem.tooltip = 'Raven: Verification was successful';
	verificationStatusBarItem.color = new vscode.ThemeColor('charts.green');
	verificationStatusBarItem.hide();
	context.subscriptions.push(verificationStatusBarItem);

	// Create the failed status bar item
	const verificationFailedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationFailedStatusBarItem.text = '$(error) Verification Failed';
	verificationFailedStatusBarItem.tooltip = 'Raven: Verification failed';
	verificationFailedStatusBarItem.color = new vscode.ThemeColor('charts.red');
	verificationFailedStatusBarItem.hide();
	context.subscriptions.push(verificationFailedStatusBarItem);

	// Create the verifying status bar item
	const verificationVerifyingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationVerifyingStatusBarItem.text = '$(sync~spin) Raven: Verifying';
	verificationVerifyingStatusBarItem.tooltip = 'Raven: Verifying...';
	verificationVerifyingStatusBarItem.color = undefined; // Use default color
	console.log("Raven: veryingHide: 0");
	verificationVerifyingStatusBarItem.hide();
	context.subscriptions.push(verificationVerifyingStatusBarItem);

	// Listen for progress notifications from the server
	const WorkDoneProgressType = new (require('vscode-languageclient').ProgressType)();
	client.onProgress(WorkDoneProgressType, undefined, (progress: any) => {
		if (progress && progress.kind === 'begin') {
			verificationVerifyingStatusBarItem.show();
			verificationStatusBarItem.hide();
			verificationFailedStatusBarItem.hide();
		} else if (progress && progress.kind === 'end') {
			verificationVerifyingStatusBarItem.hide();
			verificationStatusBarItem.hide();
			verificationFailedStatusBarItem.hide();
		}
	});

	// On any document change, show verifying and hide both success/fail
	vscode.workspace.onDidChangeTextDocument((e) => {
		verificationVerifyingStatusBarItem.show();
		verificationStatusBarItem.hide();
		verificationFailedStatusBarItem.hide();
	});

	// Show/hide the badge based on diagnostics
	vscode.languages.onDidChangeDiagnostics((e) => {
		const diagnostics = vscode.languages.getDiagnostics();
		const hasErrors = diagnostics.some(([uri, diags]) => diags.some(d => d.severity === vscode.DiagnosticSeverity.Error));
		if (hasErrors) {
			verificationStatusBarItem.hide();
			verificationFailedStatusBarItem.show();
			verificationVerifyingStatusBarItem.hide();
		} else {
			verificationFailedStatusBarItem.hide();
			verificationStatusBarItem.show();
			verificationVerifyingStatusBarItem.hide();
		}
	});

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

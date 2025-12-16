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
let verificationSucceededStatusBarItem: vscode.StatusBarItem;
let verificationFailedStatusBarItem: vscode.StatusBarItem;
let verificationVerifyingStatusBarItem: vscode.StatusBarItem;

function getActiveRavenEditor(): vscode.TextEditor | undefined {
	const editor = vscode.window.activeTextEditor;
	return editor && editor.document.languageId === 'raven' ? editor : undefined;
}

function updateStatusBar(editor: vscode.TextEditor | undefined) {
	// Always hide everything first
	verificationSucceededStatusBarItem.hide();
	verificationFailedStatusBarItem.hide();
	verificationVerifyingStatusBarItem.hide();

	if (!editor) {
		return;
	}

	// Check diagnostics for errors
	const diagnostics = vscode.languages.getDiagnostics(editor.document.uri);
	const hasErrors = diagnostics.some(d => d.severity === vscode.DiagnosticSeverity.Error);

	if (hasErrors) {
		verificationFailedStatusBarItem.show();
	} else {
		// If no errors, we assume success unless we are verifying (which is handled by progress)
		// However, we need to know if we are currently verifying to decide whether to show "Success" or "Verifying".
		// The original logic just showed "Success" if no errors, and "Verifying" was triggered by progress.
		// We will show "Success" here. Progress events will override this.
		verificationSucceededStatusBarItem.show();
	}
}

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

	// Create the status bar items
	verificationSucceededStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationSucceededStatusBarItem.text = '$(check) Verification Successful';
	verificationSucceededStatusBarItem.tooltip = 'Raven: Verification was successful';
	verificationSucceededStatusBarItem.color = new vscode.ThemeColor('charts.green');
	context.subscriptions.push(verificationSucceededStatusBarItem);

	verificationFailedStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationFailedStatusBarItem.text = '$(error) Verification Failed';
	verificationFailedStatusBarItem.tooltip = 'Raven: Verification failed';
	verificationFailedStatusBarItem.color = new vscode.ThemeColor('charts.red');
	context.subscriptions.push(verificationFailedStatusBarItem);

	verificationVerifyingStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
	verificationVerifyingStatusBarItem.text = '$(sync~spin) Raven: Verifying';
	verificationVerifyingStatusBarItem.tooltip = 'Raven: Verifying...';
	verificationVerifyingStatusBarItem.color = undefined;
	context.subscriptions.push(verificationVerifyingStatusBarItem);

	// Listen for progress notifications from the server
	const WorkDoneProgressType = new ProgressType<any>();
	client.onProgress(WorkDoneProgressType, undefined, (progress: any) => {
		const editor = getActiveRavenEditor();
		if (!editor) return; // if we aren't looking at a raven file, don't show progress? 
		// Or maybe we SHOULD show progress but only if it's relevant?
		// For simplicity/cleanup, let's only show if active editor is Raven.

		if (progress && progress.kind === 'begin') {
			verificationVerifyingStatusBarItem.show();
			verificationSucceededStatusBarItem.hide();
			verificationFailedStatusBarItem.hide();
		} else if (progress && progress.kind === 'end') {
			verificationVerifyingStatusBarItem.hide();
			// Re-assess status
			updateStatusBar(editor);
		}
	});

	// On active editor change
	vscode.window.onDidChangeActiveTextEditor(editor => {
		updateStatusBar(getActiveRavenEditor());
	});

	// On any document change - only if it's the active raven file
	vscode.workspace.onDidChangeTextDocument((e) => {
		const editor = getActiveRavenEditor();
		if (editor && e.document === editor.document) {
			verificationVerifyingStatusBarItem.show();
			verificationSucceededStatusBarItem.hide();
			verificationFailedStatusBarItem.hide();
		}
	});

	// Show/hide the badge based on diagnostics
	vscode.languages.onDidChangeDiagnostics((e) => {
		const editor = getActiveRavenEditor();
		if (editor && e.uris.some(uri => uri.toString() === editor.document.uri.toString())) {
			// If diagnostics changed for the current file, update.
			// Note: if we are currently "verifying" (status bar spinning), we might NOT want to immediately clobber it 
			// if diagnostics arrive mid-verification. BUT usually diagnostics arrive at the END of verification.
			// So it is safe to update.
			updateStatusBar(editor);
		}
	});

	// Start the client. This will also launch the server
	client.start().then(() => {
		// Initial update
		updateStatusBar(getActiveRavenEditor());
	});

	// Register manual verification command
	context.subscriptions.push(vscode.commands.registerCommand('raven.verify', () => {
		const editor = getActiveRavenEditor();
		if (editor) {
			// Provide immediate feedback
			verificationVerifyingStatusBarItem.show();
			verificationSucceededStatusBarItem.hide();
			verificationFailedStatusBarItem.hide();

			// Trigger verification
			client.sendNotification('raven/verify', { uri: editor.document.uri.toString() });
		}
	}));
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

/**
 * The errors a check has found so far (LSP protocol 4), shown while it runs. The editor
 * still shows the previous check's diagnostics until this one is done, so only those not
 * shown already are added; all are dropped once the check's result is in.
 */

import * as vscode from 'vscode';
import { State } from 'vscode-languageclient';
import type { LanguageClient, Diagnostic as LspDiagnostic } from 'vscode-languageclient/node';
import type { VerificationUpdate } from './verificationStatus';

interface ProgressDiagnostics { uri: string, version: number, runId: number, diagnostics: LspDiagnostic[] }

/** Registers the diagnostics, and returns what the check's state updates call. */
export function registerProgressDiagnostics(context: vscode.ExtensionContext, client: LanguageClient):
	{ onVerificationState: (update: VerificationUpdate) => void } {
	const collection = vscode.languages.createDiagnosticCollection('raven-progress');
	/** The run whose errors are shown, for each document. */
	const runs = new Map<string, number>();
	const drop = (uri: string) => {
		runs.delete(uri);
		collection.delete(vscode.Uri.parse(uri));
	};
	const shown = (uri: vscode.Uri, diagnostic: vscode.Diagnostic) =>
		vscode.languages.getDiagnostics(uri).some(other =>
			other.message === diagnostic.message && other.range.isEqual(diagnostic.range));
	context.subscriptions.push(collection,
		client.onNotification('raven/progressDiagnostics', async (update: ProgressDiagnostics) => {
			const document = vscode.workspace.textDocuments.find(d => d.uri.toString() === update.uri);
			if (document?.version !== update.version || (runs.get(update.uri) ?? -1) > update.runId) return;
			runs.set(update.uri, update.runId);
			const diagnostics = await client.protocol2CodeConverter.asDiagnostics(update.diagnostics);
			if (runs.get(update.uri) !== update.runId) return;
			const uri = vscode.Uri.parse(update.uri);
			collection.delete(uri);
			collection.set(uri, diagnostics.filter(d => !shown(uri, d)));
		}),
		vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
			if (contentChanges.length > 0) drop(document.uri.toString());
		}),
		vscode.workspace.onDidCloseTextDocument(document => drop(document.uri.toString())),
		client.onDidChangeState(({ newState }) => {
			if (newState === State.Starting || newState === State.Stopped) {
				runs.clear();
				collection.clear();
			}
		}));
	return {
		// A new run, or the result of the last, replaces what was found so far.
		onVerificationState: update => {
			if (update.state !== 'running' || (runs.get(update.uri) ?? -1) < update.runId) drop(update.uri);
		}
	};
}

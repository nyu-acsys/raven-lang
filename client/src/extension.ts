/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { execFile } from 'child_process';
import { workspace, ExtensionContext } from 'vscode';
import * as vscode from 'vscode';
import { ProgressType } from 'vscode-languageclient';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

import {
	RavenBinary,
	bundledZ3Version,
	checkForUpdates,
	managedVersions,
	normalizeVersion,
	pinnedVersion,
	pruneManagedInstalls,
	readManifest,
	readVersion,
	resolveRavenBinary,
	spawnEnv,
	updateChannel
} from './ravenBinary';
import { Release, fetchRelease, incompatibilityReason, installRelease, isNewer } from './ravenUpdate';

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

// Scheme for Raven's own library sources. Those are embedded in the verifier rather
// than being files on disk, so a diagnostic pointing into one has nothing to open. The
// provider below serves their text straight from the binary that produced the
// diagnostic, so what you read is always what was actually verified.
//
// Serving them under a scheme of their own, rather than writing copies somewhere and
// opening those as files, buys two things for free. A document backed by a content
// provider is read-only, so no editable copy can drift from what the verifier uses. And
// the language client's documentSelector matches `scheme: 'file'` only, so these are
// never sent to the server and never verified -- which matters, because a library
// source does not check on its own: they are verified as a set, each referring to
// declarations in the others. Syntax highlighting is unaffected, since that follows the
// `.rav` extension in the path rather than the scheme.
export const LIBRARY_SCHEME = 'raven-stdlib';

/**
 * The verifier currently in use. Resolved by `ravenBinary.ts`, and re-resolved whenever
 * something that feeds into that decision changes -- a setting, or a verifier we just
 * installed. Everything that spawns Raven reads it from here, so the library sources on
 * screen always come from the same binary that produced the diagnostic pointing at them.
 */
let currentBinary: RavenBinary;

class LibrarySourceProvider implements vscode.TextDocumentContentProvider {
	private readonly changes = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.changes.event;

	/** A different verifier means different library text; reload what is open. */
	invalidate(): void {
		for (const doc of vscode.workspace.textDocuments) {
			if (doc.uri.scheme === LIBRARY_SCHEME) this.changes.fire(doc.uri);
		}
	}

	provideTextDocumentContent(uri: vscode.Uri): Thenable<string> {
		// The path carries the source's name exactly as the verifier reports it, e.g.
		// `lib/library/resource_algebra.rav`.
		const name = uri.path.replace(/^\/+/, '');
		return new Promise<string>((resolve) => {
			execFile(
				currentBinary.executable,
				['--shh', '--print-library-source', name],
				{ env: spawnEnv(currentBinary) },
				(err, stdout) => {
					resolve(err
						? `// Could not load the Raven library source '${name}'.\n// ${err.message}`
						: stdout);
				});
		});
	}
}

/** Describe the verifier in use, for the status command and the log. */
async function describeBinary(binary: RavenBinary): Promise<string> {
	const manifest = await readManifest(binary);
	const version = manifest?.version ?? await readVersion(binary) ?? 'unknown version';
	const where = {
		configured: 'from `ravenServer.executablePath`',
		managed: 'downloaded by this extension',
		bundled: 'bundled with this extension',
		path: 'found on PATH'
	}[binary.source];
	return `Raven ${version} (${where}): ${binary.executable}`;
}

/** The version of the verifier in use, or undefined if it cannot say. */
async function currentVersion(binary: RavenBinary): Promise<string | undefined> {
	if (binary.version) return binary.version;
	const manifest = await readManifest(binary);
	return manifest?.version ?? await readVersion(binary);
}

const LAST_CHECK_KEY = 'raven.lastUpdateCheck';
const SKIPPED_VERSION_KEY = 'raven.skippedVersion';
const WARNED_VERSION_KEY = 'raven.warnedIncompatibleVersion';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Look for a newer verifier and offer to install it.
 *
 * `explicit` distinguishes the user asking from the once-a-day check on startup. An
 * automatic check stays quiet unless it has something to offer -- it must never block
 * activation, nag about a version already declined, or report that the network is down.
 * An explicit one always says what it found.
 */
async function checkForUpdate(context: ExtensionContext, explicit: boolean): Promise<void> {
	const channel = updateChannel();
	if (channel === 'bundled') {
		if (explicit) {
			const choice = await vscode.window.showInformationMessage(
				'Raven is set to use only the verifier bundled with this extension (`ravenServer.updateChannel` is `bundled`).',
				'Enable Updates');
			if (choice === 'Enable Updates') {
				await workspace.getConfiguration('ravenServer')
					.update('updateChannel', 'stable', vscode.ConfigurationTarget.Global);
			}
		}
		return;
	}

	const pinned = channel === 'tag' ? pinnedVersion() : '';
	if (channel === 'tag' && !pinned) {
		if (explicit) {
			vscode.window.showWarningMessage(
				'`ravenServer.updateChannel` is `tag`, but `ravenServer.ravenVersion` is empty. Set it to a Raven release tag, e.g. `v1.2.0`.');
		}
		return;
	}

	if (!explicit) {
		const last = context.globalState.get<number>(LAST_CHECK_KEY, 0);
		if (Date.now() - last < CHECK_INTERVAL_MS) return;
		await context.globalState.update(LAST_CHECK_KEY, Date.now());
	}

	let release;
	try {
		release = await fetchRelease(pinned ? `v${pinned}` : undefined);
	} catch (err: any) {
		// Offline, rate-limited, or GitHub is having a day. None of that is worth
		// interrupting someone who did not ask.
		client?.outputChannel.appendLine(`Raven update check failed: ${err.message}`);
		if (explicit) {
			vscode.window.showWarningMessage(`Could not check for Raven updates: ${err.message}`);
		}
		return;
	}

	if (!release) {
		if (explicit) {
			vscode.window.showInformationMessage(
				pinned
					? `Raven ${pinned} does not publish the release manifest this extension needs to install it automatically.`
					: 'The latest Raven release does not publish the release manifest this extension needs to install it automatically.');
		}
		return;
	}

	const incompatible = incompatibilityReason(release.manifest, await bundledZ3Version(currentBinary));
	if (incompatible) {
		// Worth saying even when unasked: the user is on an extension that has stopped
		// being able to follow Raven, and nothing will change until they update it. But
		// only once per release -- the situation persists until the extension is
		// updated, and a warning every morning until then would be noise.
		const alreadyWarned = context.globalState.get<string>(WARNED_VERSION_KEY) === release.manifest.version;
		if (explicit || !alreadyWarned) {
			await context.globalState.update(WARNED_VERSION_KEY, release.manifest.version);
			vscode.window.showWarningMessage(incompatible);
		}
		return;
	}

	const installed = await currentVersion(currentBinary);
	const available = release.manifest.version;

	// On the `tag` channel the pinned release is what the user asked for, newer or not:
	// pinning to an older Raven to reproduce something is a legitimate thing to want.
	// Everywhere else, only move forwards.
	const wanted = pinned
		? !managedVersions(context).includes(normalizeVersion(available))
		: isNewer(available, installed);
	if (!wanted) {
		if (explicit) {
			vscode.window.showInformationMessage(`Raven ${installed ?? available} is up to date.`);
		}
		return;
	}

	if (!explicit && context.globalState.get<string>(SKIPPED_VERSION_KEY) === available) {
		return;
	}

	if (pinned) {
		const install = 'Install';
		const choice = await vscode.window.showInformationMessage(
			`Raven ${available} is pinned by \`ravenServer.ravenVersion\` but is not installed.`,
			install);
		if (choice !== install) return;
	} else {
		const update = 'Update';
		const skip = 'Skip This Version';
		const never = 'Never Check';
		const choice = await vscode.window.showInformationMessage(
			`Raven ${available} is available${installed ? ` (you have ${installed})` : ''}.`,
			update, skip, never);
		if (choice === skip) {
			await context.globalState.update(SKIPPED_VERSION_KEY, available);
			return;
		}
		if (choice === never) {
			await workspace.getConfiguration('ravenServer')
				.update('checkForUpdates', false, vscode.ConfigurationTarget.Global);
			return;
		}
		if (choice !== update) return;
	}

	await performUpdate(context, release);
}

async function performUpdate(context: ExtensionContext, release: Release): Promise<void> {
	try {
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Installing Raven ${release.manifest.version}`,
			cancellable: true
		}, async (progress, token) => {
			let reported = 0;
			await installRelease(context, release, (fraction, message) => {
				progress.report({ increment: Math.max(0, (fraction - reported) * 100), message });
				reported = fraction;
			}, token);
		});
	} catch (err: any) {
		vscode.window.showErrorMessage(`Installing Raven ${release.manifest.version} failed: ${err.message}`);
		return;
	}

	const version = release.manifest.version;
	await context.globalState.update(SKIPPED_VERSION_KEY, undefined);
	// The previous version is kept as well, so a bad release can be backed out of by
	// deleting the new directory rather than reinstalling from scratch.
	pruneManagedInstalls(context, [version]);
	refreshBinary(context);
	vscode.window.showInformationMessage(`Raven ${version} is now in use.`);
}

/** Providers that hold onto the resolved binary and must be told when it changes. */
let librarySources: LibrarySourceProvider;

/**
 * Re-resolve which verifier to use and tell the server. Cheap enough to call on any
 * event that could plausibly change the answer.
 */
function refreshBinary(context: ExtensionContext): void {
	const previous = currentBinary?.executable;
	currentBinary = resolveRavenBinary(context);
	if (currentBinary.executable === previous) return;

	librarySources?.invalidate();
	if (client?.isRunning()) {
		client.sendNotification('raven/executable', {
			executable: currentBinary.executable,
			z3Dir: currentBinary.z3Dir
		}).catch(() => { /* the server will get it at the next start */ });
	}
	client?.outputChannel.appendLine(`Using Raven at ${currentBinary.executable} (${currentBinary.source})`);
}

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	// Populated only in platform-specific packages that bundle raven/z3;
	// absent (and harmless) when running from source or an unbundled build.
	const bundledBinDir = context.asAbsolutePath(path.join('bundled', 'bin'));

	currentBinary = resolveRavenBinary(context);

	librarySources = new LibrarySourceProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(LIBRARY_SCHEME, librarySources));

	if (process.platform === 'darwin') {
		// Marketplace downloads land with com.apple.quarantine set, which makes
		// Gatekeeper refuse to run the unsigned bundled binaries. Best-effort
		// strip; harmless if the dir doesn't exist or xattr isn't present.
		execFile('xattr', ['-dr', 'com.apple.quarantine', bundledBinDir], () => { /* ignore errors */ });
	}

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
		},
		initializationOptions: {
			raven: {
				executable: currentBinary.executable,
				z3Dir: currentBinary.z3Dir
			}
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

		// Deliberately not awaited: a verifier update is never worth delaying the point
		// at which the extension becomes usable, and the check may have to wait on the
		// network. Whatever it finds is offered once it arrives.
		if (checkForUpdates()) {
			checkForUpdate(context, false).catch(err =>
				client.outputChannel.appendLine(`Raven update check failed: ${err.message}`));
		}
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

	context.subscriptions.push(vscode.commands.registerCommand('raven.updateVerifier', () =>
		checkForUpdate(context, true)));

	context.subscriptions.push(vscode.commands.registerCommand('raven.showVerifierVersion', async () => {
		vscode.window.showInformationMessage(await describeBinary(currentBinary));
	}));

	context.subscriptions.push(vscode.commands.registerCommand('raven.useBundledVerifier', async () => {
		await workspace.getConfiguration('ravenServer')
			.update('updateChannel', 'bundled', vscode.ConfigurationTarget.Global);
		refreshBinary(context);
		vscode.window.showInformationMessage(await describeBinary(currentBinary));
	}));

	// Anything that feeds into which verifier we run.
	context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('ravenServer.executablePath')
			|| event.affectsConfiguration('ravenServer.updateChannel')
			|| event.affectsConfiguration('ravenServer.ravenVersion')) {
			refreshBinary(context);
		}
	}));
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

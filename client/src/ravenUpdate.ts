/* --------------------------------------------------------------------------------------------
 * Fetching and installing Raven verifiers from GitHub releases.
 *
 * The extension bundles a verifier so it works offline and on first run, but a Raven
 * release that changes nothing about the extension should not require re-releasing the
 * extension to carry it. This module is what lets the two be released independently: it
 * reads a release's `manifest.json` to decide whether this extension can drive that
 * build at all, and only then downloads, verifies and installs it.
 *
 * Deliberately dependency-free -- Node's https, crypto and the platform `tar` are enough,
 * and an auto-updater is the last place to want an unaudited dependency.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ExtensionContext, CancellationToken } from 'vscode';
import {
	Manifest,
	RAVEN_REPO,
	SUPPORTED_PROTOCOL,
	compareVersions,
	managedExecutable,
	managedRoot,
	normalizeVersion,
	readManifest
} from './ravenBinary';

const execFileAsync = promisify(execFile);

const USER_AGENT = 'nyu-acsys.raven-verifier';
const MANIFEST_ASSET = 'manifest.json';
const CHECKSUM_ASSET = 'SHA256SUMS';

export interface Release {
	/** The git tag, `v`-prefixed. */
	tag: string;
	manifest: Manifest;
	assets: Map<string, string>;
}

/** Names the release archive for the platform we are running on. */
export function platformAsset(): string | undefined {
	const platform = process.platform;
	const arch = process.arch;
	const targets: Record<string, string> = {
		'linux-x64': 'raven-linux-x64',
		'linux-arm64': 'raven-linux-arm64',
		'darwin-x64': 'raven-darwin-x64',
		'darwin-arm64': 'raven-darwin-arm64',
		'win32-x64': 'raven-win32-x64'
	};
	const target = targets[`${platform}-${arch}`];
	return target ? `${target}.tar.gz` : undefined;
}

// --- HTTP -----------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
	// Unauthenticated GitHub API access is limited to 60 requests per hour per IP.
	// That is ample for a once-a-day check, but a token makes testing and CI painless.
	const token = process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/** No Raven release archive comes close to this; it exists to bound a stuck download. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

/** A connection that goes quiet should fail rather than hang the check forever. */
const IDLE_TIMEOUT_MS = 60000;

function request(url: string, headers: Record<string, string>, token?: CancellationToken): Promise<{ response: import('http').IncomingMessage }> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': USER_AGENT, ...headers },
			timeout: IDLE_TIMEOUT_MS
		}, response => {
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.resume();
				const target = new URL(location, url);
				// Release asset downloads redirect to a storage host; carrying the
				// Authorization header across would hand our token to a third party.
				const sameHost = target.host === new URL(url).host;
				resolve(request(target.toString(), sameHost ? headers : {}, token));
				return;
			}
			if (status < 200 || status >= 300) {
				response.resume();
				reject(new Error(`GET ${url} failed with HTTP ${status}`));
				return;
			}
			resolve({ response });
		});
		const cancellation = token?.onCancellationRequested(() => {
			req.destroy(new Error('Cancelled'));
		});
		req.on('timeout', () => req.destroy(new Error(`GET ${url} timed out`)));
		req.on('error', reject);
		req.on('close', () => cancellation?.dispose());
	});
}

async function getBuffer(url: string, headers: Record<string, string> = {}, token?: CancellationToken,
	onProgress?: (received: number, total: number | undefined) => void): Promise<Buffer> {
	const { response } = await request(url, headers, token);
	const lengthHeader = response.headers['content-length'];
	const total = lengthHeader ? Number(lengthHeader) : undefined;
	const chunks: Buffer[] = [];
	let received = 0;
	return new Promise<Buffer>((resolve, reject) => {
		response.on('data', (chunk: Buffer) => {
			received += chunk.length;
			if (received > MAX_DOWNLOAD_BYTES) {
				response.destroy();
				reject(new Error(`GET ${url} exceeded ${MAX_DOWNLOAD_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
			onProgress?.(received, total);
		});
		response.on('end', () => resolve(Buffer.concat(chunks)));
		response.on('error', reject);
	});
}

async function getJson(url: string, token?: CancellationToken): Promise<any> {
	const body = await getBuffer(url, { Accept: 'application/vnd.github+json', ...authHeaders() }, token);
	return JSON.parse(body.toString('utf8'));
}

// --- Releases -------------------------------------------------------------------------

/**
 * Look up a release and read its manifest. Returns undefined for a release that
 * publishes no manifest: every Raven from before this mechanism existed, which we
 * therefore cannot make any compatibility claim about and will not install.
 */
export async function fetchRelease(tag: string | undefined, token?: CancellationToken): Promise<Release | undefined> {
	const base = `https://api.github.com/repos/${RAVEN_REPO.owner}/${RAVEN_REPO.repo}/releases`;
	const url = tag ? `${base}/tags/${encodeURIComponent(tag)}` : `${base}/latest`;
	const release = await getJson(url, token);

	const assets = new Map<string, string>();
	for (const asset of release.assets ?? []) {
		assets.set(asset.name, asset.browser_download_url);
	}

	const manifestUrl = assets.get(MANIFEST_ASSET);
	if (!manifestUrl) return undefined;

	const manifest = JSON.parse((await getBuffer(manifestUrl, authHeaders(), token)).toString('utf8'));
	if (typeof manifest?.version !== 'string' || typeof manifest?.lsp_protocol !== 'number') {
		return undefined;
	}
	return { tag: release.tag_name, manifest, assets };
}

/**
 * Why this extension cannot drive the given release, or undefined if it can. Both checks
 * exist because the extension can end up running a verifier much newer than itself: the
 * protocol is the interface between them, and z3 is a component the extension supplies
 * but the verifier dictates the requirements for.
 */
export function incompatibilityReason(manifest: Manifest, z3Version: string | undefined): string | undefined {
	if (manifest.lsp_protocol > SUPPORTED_PROTOCOL.max) {
		return `Raven ${manifest.version} speaks a newer editor interface (protocol ${manifest.lsp_protocol}) than this extension understands (up to ${SUPPORTED_PROTOCOL.max}). Update the Raven extension to use it.`;
	}
	if (manifest.lsp_protocol < SUPPORTED_PROTOCOL.min) {
		return `Raven ${manifest.version} speaks an editor interface (protocol ${manifest.lsp_protocol}) this extension no longer supports.`;
	}
	if (z3Version && manifest.min_z3 && compareVersions(z3Version, manifest.min_z3) < 0) {
		return `Raven ${manifest.version} needs Z3 ${manifest.min_z3} or newer, but this extension bundles ${z3Version}. Update the Raven extension to get a newer Z3.`;
	}
	return undefined;
}

// --- Installation ---------------------------------------------------------------------

/** Parse `sha256sum` output: a hex digest, whitespace, an optional `*`, and the name. */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split('\n')) {
		const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
		if (match) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

async function extractArchive(archive: string, destination: string): Promise<void> {
	// bsdtar ships with Windows 10 1803 and later, so `tar` is available everywhere the
	// extension runs and needs no bundled extractor.
	await execFileAsync('tar', ['-xzf', archive, '-C', destination], { timeout: 120000 });
}

export interface InstallProgress {
	(fraction: number, message: string): void;
}

/**
 * Download and install a release, replacing any existing install of that version.
 *
 * Everything happens in a scratch directory that is only moved into place once the
 * result has been checksummed and shown to run. A half-written or subtly wrong install
 * under the real path would be worse than no install at all, since the extension would
 * pick it up on the next start and keep failing. Versioned directories also mean nothing
 * is ever written over a binary that may be executing, which is what makes this work on
 * Windows.
 */
export async function installRelease(
	context: ExtensionContext,
	release: Release,
	progress: InstallProgress,
	token?: CancellationToken
): Promise<string> {
	const assetName = platformAsset();
	if (!assetName) {
		throw new Error(`Raven does not publish a build for ${process.platform}-${process.arch}.`);
	}
	const assetUrl = release.assets.get(assetName);
	if (!assetUrl) {
		throw new Error(`Release ${release.tag} has no ${assetName} asset.`);
	}

	const version = normalizeVersion(release.manifest.version);
	const root = managedRoot(context);
	fs.mkdirSync(root, { recursive: true });
	const staging = path.join(root, `.staging-${version}-${process.pid}`);
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });

	try {
		progress(0, 'Downloading');
		const archive = await getBuffer(assetUrl, authHeaders(), token, (received, total) => {
			// Downloading is the only part with a meaningful fraction, so it gets most
			// of the bar; the remaining steps are fast and reported by name.
			const fraction = total ? (received / total) * 0.8 : 0;
			const mb = (received / (1024 * 1024)).toFixed(1);
			progress(fraction, total ? `Downloading Raven ${version} (${mb} MB)` : `Downloading Raven ${version}`);
		});

		progress(0.8, 'Verifying download');
		// A release that publishes no checksums at all predates them, and the download
		// still came over TLS from GitHub. But once the file exists, an archive it does
		// not vouch for is a failure -- treating an unparseable or incomplete SHA256SUMS
		// as "nothing to check" would quietly turn verification off exactly when
		// something is wrong.
		const checksumUrl = release.assets.get(CHECKSUM_ASSET);
		if (checksumUrl) {
			const sums = parseChecksums((await getBuffer(checksumUrl, authHeaders(), token)).toString('utf8'));
			const expected = sums.get(assetName);
			if (!expected) {
				throw new Error(`${CHECKSUM_ASSET} for ${release.tag} has no entry for ${assetName}.`);
			}
			const actual = crypto.createHash('sha256').update(archive).digest('hex');
			if (expected !== actual) {
				throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}.`);
			}
		}

		const archivePath = path.join(staging, assetName);
		fs.writeFileSync(archivePath, archive);

		progress(0.85, 'Extracting');
		await extractArchive(archivePath, staging);
		fs.rmSync(archivePath, { force: true });

		const executable = path.join(staging, process.platform === 'win32' ? 'raven.exe' : 'raven');
		if (!fs.existsSync(executable)) {
			throw new Error(`${assetName} did not contain a raven executable.`);
		}
		if (process.platform !== 'win32') {
			fs.chmodSync(executable, 0o755);
		}
		if (process.platform === 'darwin') {
			// Files we wrote ourselves should not carry com.apple.quarantine, but the
			// bundled binaries need this after a Marketplace download and the cost of
			// being wrong here is a Gatekeeper dialog instead of a working verifier.
			// Best-effort, and the smoke test below is what actually decides.
			await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', staging]).catch(() => { /* ignore */ });
		}

		// Prove it runs and is what the release said it was before letting the rest of
		// the extension near it. A binary for the wrong platform, or one truncated by a
		// proxy, fails here rather than on the user's next keystroke.
		progress(0.95, 'Checking the downloaded verifier');
		const staged = { source: 'managed' as const, executable, z3Dir: undefined };
		const manifest = await readManifest(staged);
		if (!manifest) {
			throw new Error('The downloaded verifier could not be run.');
		}
		if (normalizeVersion(manifest.version) !== version) {
			throw new Error(`The downloaded verifier reports version ${manifest.version}, but the release announced ${release.manifest.version}.`);
		}

		const target = path.join(root, version);
		fs.rmSync(target, { recursive: true, force: true });
		fs.renameSync(staging, target);
		progress(1, 'Installed');
		return managedExecutable(context, version);
	} catch (err) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw err;
	}
}

/** Whether `candidate` is a version worth moving to from `current`. */
export function isNewer(candidate: string, current: string | undefined): boolean {
	if (!current) return true;
	return compareVersions(candidate, current) > 0;
}

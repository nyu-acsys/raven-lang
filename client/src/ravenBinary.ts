/* --------------------------------------------------------------------------------------------
 * Which `raven` this extension runs, and what it can tell us about itself.
 *
 * The client is the sole owner of this decision. The language server used to repeat the
 * same fallback chain, which was fine while the answer could only change by editing a
 * setting, but the extension can now install verifiers of its own -- so the answer
 * changes while the server is running, and two copies of the logic would drift. The
 * client resolves, and tells the server (see `pushExecutable` in extension.ts).
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { workspace, ExtensionContext } from 'vscode';

const execFileAsync = promisify(execFile);

/** The repository releases are fetched from. */
export const RAVEN_REPO = { owner: 'nyu-acsys', repo: 'raven' };

/**
 * The range of `lsp_protocol` values this extension knows how to drive -- the JSON
 * diagnostic schema Raven emits under `--lsp-mode`, together with the flags the server
 * invokes it with. Because the extension can run a verifier it was not shipped with,
 * this is a real compatibility boundary rather than a formality: a release announcing a
 * protocol outside this range is one this extension must decline to install, telling the
 * user to update the extension instead of failing mysteriously later.
 *
 * Widen `max` when adapting to a new protocol; raise `min` only when dropping support
 * for an old one.
 */
export const SUPPORTED_PROTOCOL = { min: 1, max: 1 };

/** What `raven --manifest` prints, and what a release publishes as `manifest.json`. */
export interface Manifest {
	version: string;
	lsp_protocol: number;
	min_z3: string;
}

export type BinarySource = 'configured' | 'managed' | 'bundled' | 'path';

export interface RavenBinary {
	source: BinarySource;
	executable: string;
	/**
	 * Directory to prepend to PATH when spawning, so Raven finds the bundled z3. Set
	 * whenever the extension ships binaries, independently of where `raven` itself came
	 * from: a downloaded verifier still uses the z3 packaged with the extension.
	 */
	z3Dir?: string;
	/** Present only for managed installs, where the version names the directory. */
	version?: string;
}

export type UpdateChannel = 'stable' | 'tag' | 'bundled';

function exeName(stem: string): string {
	return process.platform === 'win32' ? `${stem}.exe` : stem;
}

function config() {
	return workspace.getConfiguration('ravenServer');
}

export function updateChannel(): UpdateChannel {
	const value = config().get<string>('updateChannel', 'stable');
	return value === 'tag' || value === 'bundled' ? value : 'stable';
}

export function pinnedVersion(): string {
	return normalizeVersion(config().get<string>('ravenVersion', '').trim());
}

export function checkForUpdates(): boolean {
	return config().get<boolean>('checkForUpdates', true);
}

export function configuredExecutablePath(): string {
	return config().get<string>('executablePath', '').trim();
}

/** Release tags are `v`-prefixed; versions inside manifests are not. Compare bare. */
export function normalizeVersion(version: string): string {
	return version.replace(/^v/, '');
}

/**
 * Compare dotted numeric versions. Non-numeric trailing parts (`1.2.0-rc1`) compare by
 * their numeric prefix and then lexically, which is enough to order the release tags
 * Raven actually uses without pulling in a semver dependency.
 */
export function compareVersions(a: string, b: string): number {
	const partsOf = (v: string) => normalizeVersion(v).split(/[.+-]/);
	const as = partsOf(a);
	const bs = partsOf(b);
	for (let i = 0; i < Math.max(as.length, bs.length); i++) {
		const x = as[i] ?? '';
		const y = bs[i] ?? '';
		const nx = Number(x);
		const ny = Number(y);
		if (Number.isInteger(nx) && Number.isInteger(ny)) {
			if (nx !== ny) return nx < ny ? -1 : 1;
		} else if (x !== y) {
			// A version with a suffix (1.2.0-rc1) sorts before the bare one (1.2.0).
			if (x === '') return 1;
			if (y === '') return -1;
			return x < y ? -1 : 1;
		}
	}
	return 0;
}

/** Where the extension's own bundled binaries live; absent in unbundled dev builds. */
export function bundledBinDir(context: ExtensionContext): string {
	return context.asAbsolutePath(path.join('bundled', 'bin'));
}

/** Root of the verifiers this extension has installed, one directory per version. */
export function managedRoot(context: ExtensionContext): string {
	return path.join(context.globalStorageUri.fsPath, 'verifier');
}

export function managedExecutable(context: ExtensionContext, version: string): string {
	return path.join(managedRoot(context), normalizeVersion(version), exeName('raven'));
}

/** Versions installed under {@link managedRoot}, newest first. */
export function managedVersions(context: ExtensionContext): string[] {
	const root = managedRoot(context);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter(e => e.isDirectory() && fs.existsSync(path.join(root, e.name, exeName('raven'))))
		.map(e => e.name)
		.sort((a, b) => compareVersions(b, a));
}

/**
 * Decide which verifier to run. In order: an explicitly configured path (the dev-build
 * override, which always wins), then a verifier this extension installed, then the one
 * bundled with the extension, then whatever `raven` is on PATH.
 *
 * The bundled binary is a floor, not a pin: it is what makes the extension work offline
 * and on first run, and it is what we fall back to whenever the managed copy is absent
 * or the user has opted out of updates.
 */
export function resolveRavenBinary(context: ExtensionContext): RavenBinary {
	const binDir = bundledBinDir(context);
	const z3Dir = fs.existsSync(path.join(binDir, exeName('z3'))) ? binDir : undefined;

	const configured = configuredExecutablePath();
	if (configured) {
		return { source: 'configured', executable: configured, z3Dir };
	}

	const channel = updateChannel();
	if (channel !== 'bundled') {
		// On the `tag` channel only the pinned version will do; anything else installed
		// is from a previous pin and running it would silently ignore the setting.
		const pinned = pinnedVersion();
		const candidates = channel === 'tag'
			? (pinned ? [pinned] : [])
			: managedVersions(context);
		for (const version of candidates) {
			const executable = managedExecutable(context, version);
			if (fs.existsSync(executable)) {
				return { source: 'managed', executable, z3Dir, version: normalizeVersion(version) };
			}
		}
	}

	const bundled = path.join(binDir, exeName('raven'));
	if (fs.existsSync(bundled)) {
		return { source: 'bundled', executable: bundled, z3Dir };
	}

	return { source: 'path', executable: 'raven' };
}

/** Environment for spawning Raven, with the bundled z3 made findable. */
export function spawnEnv(binary: RavenBinary): NodeJS.ProcessEnv {
	if (!binary.z3Dir) return process.env;
	return { ...process.env, PATH: `${binary.z3Dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

/**
 * Ask a binary what it is. Returns undefined for anything that cannot answer -- a
 * missing file, or a Raven predating `--manifest`. Callers decide what that means:
 * tolerable for a binary the user pointed us at, disqualifying for one we are about to
 * install.
 */
export async function readManifest(binary: RavenBinary): Promise<Manifest | undefined> {
	try {
		const { stdout } = await execFileAsync(binary.executable, ['--manifest'], {
			env: spawnEnv(binary),
			timeout: 15000
		});
		const parsed = JSON.parse(stdout.trim());
		if (typeof parsed?.version === 'string' && typeof parsed?.lsp_protocol === 'number') {
			return parsed as Manifest;
		}
	} catch {
		// fall through
	}
	return undefined;
}

/** The release version of a binary, for anything old enough to lack `--manifest`. */
export async function readVersion(binary: RavenBinary): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(binary.executable, ['--version'], {
			env: spawnEnv(binary),
			timeout: 15000
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Version of the z3 the extension ships, or undefined in an unbundled build. */
export async function bundledZ3Version(binary: RavenBinary): Promise<string | undefined> {
	if (!binary.z3Dir) return undefined;
	try {
		const { stdout } = await execFileAsync(path.join(binary.z3Dir, exeName('z3')), ['--version'], {
			timeout: 15000
		});
		// "Z3 version 4.13.0 - 64 bit"
		const match = /(\d+\.\d+(?:\.\d+)*)/.exec(stdout);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Drop managed installs other than the ones worth keeping: whatever is in use, plus one
 * older version to fall back to if a new one turns out to be broken.
 */
export function pruneManagedInstalls(context: ExtensionContext, keep: string[]): void {
	const protectedVersions = new Set(keep.map(normalizeVersion));
	const versions = managedVersions(context);
	for (const version of versions.slice(0, 2)) {
		protectedVersions.add(version);
	}
	for (const version of versions) {
		if (protectedVersions.has(version)) continue;
		try {
			fs.rmSync(path.join(managedRoot(context), version), { recursive: true, force: true });
		} catch {
			// A version we failed to remove costs disk space and nothing else.
		}
	}
}

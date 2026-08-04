/*
 * Checks for the extension's client-side logic: choosing and installing a verifier
 * (client/src/ravenBinary.ts, client/src/ravenUpdate.ts) and deciding which lines get a
 * gutter marker (client/src/gutter.ts).
 *
 * Run with `npm test`, which compiles first: this exercises the built output in
 * client/out, which is what actually ships.
 *
 * The install checks run against a release fixture served over local HTTPS, built here
 * rather than committed: a stub that answers `--manifest` is all the installer looks at,
 * so the fixture needs no real verifier and the checks stay runnable anywhere. Set
 * RAVEN_TEST_NETWORK=1 to additionally query the real GitHub releases API.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const Module = require('module');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'client', 'out');

// --- vscode stub ----------------------------------------------------------------------

// The modules under test read settings through the vscode API. Nothing here runs inside
// the editor, so stand in for the parts they touch.
let settings = {};
const vscodeStub = {
	workspace: {
		getConfiguration: () => ({
			get: (key, fallback) => (key in settings ? settings[key] : fallback)
		})
	},
	// The real numeric values, so the severity comparisons under test are the real ones.
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain);
};

const binary = require(path.join(OUT, 'ravenBinary.js'));
const update = require(path.join(OUT, 'ravenUpdate.js'));
const gutter = require(path.join(OUT, 'gutter.js'));

// --- harness --------------------------------------------------------------------------

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL ${name}: ${err.message}`);
	}
}

// --- fixture --------------------------------------------------------------------------

const MANIFEST = { version: '1.2.0', lsp_protocol: 1, min_z3: '4.13.0' };

/**
 * A release directory shaped exactly like one of Raven's: a per-platform archive whose
 * single entry is the `raven` executable, a manifest, and checksums over the archives.
 */
function buildFixture(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const stage = path.join(dir, 'stage');
	fs.mkdirSync(stage, { recursive: true });

	// Enough of a verifier for the installer: it runs `--manifest` and checks the answer.
	const stub = path.join(stage, 'raven');
	fs.writeFileSync(stub, `#!/bin/sh\necho '${JSON.stringify(MANIFEST)}'\n`);
	fs.chmodSync(stub, 0o755);

	const asset = update.platformAsset();
	execFileSync('tar', ['-C', stage, '-czf', path.join(dir, asset), '.']);
	fs.rmSync(stage, { recursive: true, force: true });

	fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
	const digest = crypto.createHash('sha256')
		.update(fs.readFileSync(path.join(dir, asset))).digest('hex');
	fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${digest}  ${asset}\n`);
	return asset;
}

function serveFixture(dir, certs) {
	const server = https.createServer(certs, (req, res) => {
		// The archive is only reachable through a redirect, because that is how a real
		// GitHub asset download behaves: the API host hands off to a storage host.
		if (req.url.startsWith('/download/')) {
			res.writeHead(302, { Location: `/objects/${path.basename(req.url)}` });
			res.end();
			return;
		}
		const file = path.join(dir, path.basename(req.url));
		if (!fs.existsSync(file)) {
			res.writeHead(404);
			res.end();
			return;
		}
		const body = fs.readFileSync(file);
		res.writeHead(200, { 'Content-Length': body.length });
		res.end(body);
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A throwaway certificate for the fixture server. */
function selfSignedCert(dir) {
	const key = path.join(dir, 'key.pem');
	const cert = path.join(dir, 'cert.pem');
	execFileSync('openssl', [
		'req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
		'-days', '1', '-nodes', '-subj', '/CN=localhost',
		'-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
	], { stdio: 'ignore' });
	return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// --- checks ---------------------------------------------------------------------------

async function pureChecks() {
	console.log('version comparison');
	await check('orders release versions', () => {
		assert.strictEqual(binary.compareVersions('1.2.0', '1.3.0'), -1);
		assert.strictEqual(binary.compareVersions('1.10.0', '1.9.0'), 1);
		assert.strictEqual(binary.compareVersions('1.2.0', '1.2.0'), 0);
		assert.strictEqual(binary.compareVersions('v1.2.0', '1.2.0'), 0);
		assert.strictEqual(binary.compareVersions('1.2', '1.2.0'), 0);
	});
	await check('sorts a prerelease before its release', () => {
		assert.strictEqual(binary.compareVersions('1.3.0-rc1', '1.3.0'), -1);
		assert.strictEqual(binary.compareVersions('1.3.0', '1.3.0-rc1'), 1);
	});
	await check('isNewer treats an unknown current version as older', () => {
		assert.strictEqual(update.isNewer('1.2.0', undefined), true);
		assert.strictEqual(update.isNewer('1.2.0', '1.2.0'), false);
		assert.strictEqual(update.isNewer('1.1.0', '1.2.0'), false);
	});

	console.log('checksum parsing');
	await check('parses multiple entries and binary-mode markers', () => {
		const sums = update.parseChecksums(
			'a'.repeat(64) + '  one.tar.gz\n' + 'b'.repeat(64) + ' *two.tar.gz\n\n');
		assert.strictEqual(sums.get('one.tar.gz'), 'a'.repeat(64));
		assert.strictEqual(sums.get('two.tar.gz'), 'b'.repeat(64));
	});

	console.log('compatibility');
	await check('accepts the protocol this extension supports', () => {
		assert.strictEqual(update.incompatibilityReason(MANIFEST, '5.0.0'), undefined);
	});
	await check('declines a newer protocol', () => {
		const reason = update.incompatibilityReason(
			{ version: '9.0.0', lsp_protocol: 99, min_z3: '4.13.0' }, '5.0.0');
		assert.match(reason, /newer editor interface/);
	});
	await check('declines a release needing a newer z3 than we bundle', () => {
		const reason = update.incompatibilityReason(
			{ version: '9.0.0', lsp_protocol: 1, min_z3: '9.9.9' }, '5.0.0');
		assert.match(reason, /needs Z3 9\.9\.9/);
	});
	await check('does not judge z3 when there is no bundled z3', () => {
		assert.strictEqual(update.incompatibilityReason(
			{ version: '9.0.0', lsp_protocol: 1, min_z3: '9.9.9' }, undefined), undefined);
	});
}

// --- gutter markers -------------------------------------------------------------------

const ERROR = vscodeStub.DiagnosticSeverity.Error;
const INFO = vscodeStub.DiagnosticSeverity.Information;
const WARNING = vscodeStub.DiagnosticSeverity.Warning;

function diagnostic(line, severity, message, source = 'raven') {
	return { range: { start: { line }, end: { line, character: 10 } }, severity, message, source };
}

async function gutterChecks() {
	console.log('gutter markers');
	await check('marks failures and related locations separately', () => {
		const { errors, related } = gutter.gutterMarkers([
			diagnostic(4, ERROR, '[Verification Error] A postcondition may not hold'),
			diagnostic(9, INFO, '[Related Location] This assertion may not hold')
		]);
		assert.deepStrictEqual([...errors.keys()], [4]);
		assert.deepStrictEqual([...related.keys()], [9]);
	});
	await check('collects every message reported against a line', () => {
		const { errors } = gutter.gutterMarkers([
			diagnostic(4, ERROR, 'first'),
			diagnostic(4, ERROR, 'second')
		]);
		assert.deepStrictEqual(errors.get(4), ['first', 'second']);
	});
	await check('a failure outranks a related location on the same line', () => {
		const { errors, related } = gutter.gutterMarkers([
			diagnostic(4, INFO, '[Related Location] ...'),
			diagnostic(4, ERROR, '[Verification Error] ...')
		]);
		assert.deepStrictEqual([...errors.keys()], [4]);
		assert.strictEqual(related.size, 0, 'the line should not be marked twice');
	});
	await check('marks only the line a multi-line diagnostic starts at', () => {
		const spanning = {
			range: { start: { line: 2 }, end: { line: 40 } },
			severity: ERROR, message: 'x', source: 'raven'
		};
		assert.deepStrictEqual([...gutter.gutterMarkers([spanning]).errors.keys()], [2]);
	});
	await check('ignores other extensions\' diagnostics', () => {
		const { errors, related } = gutter.gutterMarkers([diagnostic(4, ERROR, 'x', 'eslint')]);
		assert.strictEqual(errors.size + related.size, 0);
	});
	await check('ignores the warning reported when the verifier cannot run', () => {
		// Pinned to line 1 and describing the whole run rather than that line.
		const { errors, related } = gutter.gutterMarkers([
			diagnostic(0, WARNING, 'Failed to execute the Raven verifier at ...')
		]);
		assert.strictEqual(errors.size + related.size, 0);
	});
}

async function installChecks(scratch) {
	const fixtureDir = path.join(scratch, 'release');
	const asset = buildFixture(fixtureDir);
	const server = await serveFixture(fixtureDir, selfSignedCert(scratch));
	const base = `https://127.0.0.1:${server.address().port}`;

	const storage = path.join(scratch, 'globalStorage');
	const context = {
		globalStorageUri: { fsPath: storage },
		// No bundled binaries in this tree, which is what an unbundled dev build looks
		// like -- so resolution has to fall through to the managed install or PATH.
		asAbsolutePath: p => path.join(scratch, 'extension', p)
	};

	const release = {
		tag: `v${MANIFEST.version}`,
		manifest: MANIFEST,
		assets: new Map([
			[asset, `${base}/download/${asset}`],
			['SHA256SUMS', `${base}/SHA256SUMS`],
			['manifest.json', `${base}/manifest.json`]
		])
	};

	console.log('install');
	const steps = [];
	await check('installs, verifies and smoke-tests a release', async () => {
		const executable = await update.installRelease(context, release, (f, m) => steps.push([f, m]));
		assert.ok(fs.existsSync(executable), `${executable} does not exist`);
		assert.ok(fs.statSync(executable).mode & 0o111, 'installed binary is not executable');
		assert.strictEqual(executable, path.join(storage, 'verifier', MANIFEST.version, 'raven'));
	});
	await check('reports progress through to completion', () => {
		assert.ok(steps.length > 2, 'expected several progress reports');
		assert.strictEqual(steps[steps.length - 1][0], 1);
		assert.ok(steps.some(([, m]) => /Downloading/.test(m)), 'no download progress reported');
	});
	await check('leaves no staging directory behind', () => {
		const left = fs.readdirSync(path.join(storage, 'verifier')).filter(n => n.startsWith('.staging'));
		assert.deepStrictEqual(left, []);
	});
	await check('reads the manifest back off the installed binary', async () => {
		settings = { updateChannel: 'stable', executablePath: '' };
		const read = await binary.readManifest(binary.resolveRavenBinary(context));
		assert.deepStrictEqual(read, MANIFEST);
	});

	console.log('resolution');
	await check('prefers a managed install when there is no bundle', () => {
		settings = { updateChannel: 'stable', executablePath: '' };
		assert.deepStrictEqual(binary.managedVersions(context), [MANIFEST.version]);
		const resolved = binary.resolveRavenBinary(context);
		assert.strictEqual(resolved.source, 'managed');
		assert.strictEqual(resolved.version, MANIFEST.version);
	});
	await check('an explicit executablePath overrides everything', () => {
		settings = { updateChannel: 'stable', executablePath: '/somewhere/raven' };
		const resolved = binary.resolveRavenBinary(context);
		assert.strictEqual(resolved.source, 'configured');
		assert.strictEqual(resolved.executable, '/somewhere/raven');
	});
	await check('the bundled channel ignores managed installs', () => {
		settings = { updateChannel: 'bundled', executablePath: '' };
		assert.strictEqual(binary.resolveRavenBinary(context).source, 'path');
	});
	await check('the tag channel takes only the pinned version', () => {
		settings = { updateChannel: 'tag', ravenVersion: 'v9.9.9', executablePath: '' };
		assert.strictEqual(binary.resolveRavenBinary(context).source, 'path');
		settings = { updateChannel: 'tag', ravenVersion: `v${MANIFEST.version}`, executablePath: '' };
		assert.strictEqual(binary.resolveRavenBinary(context).source, 'managed');
	});

	console.log('install failures');
	await check('rejects an archive the checksums do not vouch for', async () => {
		const bad = { ...release, assets: new Map(release.assets).set('SHA256SUMS', `${base}/manifest.json`) };
		await assert.rejects(() => update.installRelease(context, bad, () => { }),
			new RegExp(`has no entry for ${asset.replace(/\./g, '\\.')}`));
	});
	await check('rejects a release with no build for this platform', async () => {
		await assert.rejects(() => update.installRelease(context, { ...release, assets: new Map() }, () => { }),
			/has no raven-/);
	});
	await check('a failed install leaves the previous one in place', () => {
		assert.deepStrictEqual(binary.managedVersions(context), [MANIFEST.version]);
		const left = fs.readdirSync(path.join(storage, 'verifier')).filter(n => n.startsWith('.staging'));
		assert.deepStrictEqual(left, []);
	});

	console.log('pruning');
	await check('keeps the newest two installs and drops the rest', () => {
		for (const v of ['1.0.0', '1.1.0', '1.3.0']) {
			fs.mkdirSync(path.join(storage, 'verifier', v), { recursive: true });
			fs.copyFileSync(path.join(storage, 'verifier', MANIFEST.version, 'raven'),
				path.join(storage, 'verifier', v, 'raven'));
		}
		binary.pruneManagedInstalls(context, []);
		assert.deepStrictEqual(binary.managedVersions(context), ['1.3.0', '1.2.0']);
	});

	server.close();
}

async function networkChecks() {
	console.log('live GitHub lookup');
	await check('reads the latest release without throwing', async () => {
		const found = await update.fetchRelease(undefined);
		// undefined is the right answer for any release predating manifest.json; a
		// release that does publish one has to be well formed.
		if (found !== undefined) {
			assert.strictEqual(typeof found.manifest.version, 'string');
			assert.strictEqual(typeof found.manifest.lsp_protocol, 'number');
			assert.ok(found.assets.size > 0, 'release has no assets');
		}
	});
}

async function main() {
	if (process.platform === 'win32') {
		// The fixture's stand-in verifier is a shell script.
		console.log('skipping: the release fixture needs a POSIX shell');
		return;
	}

	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-updater-test-'));
	try {
		await pureChecks();
		await gutterChecks();
		// The fixture server presents a certificate no store knows about.
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		await installChecks(scratch);
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		if (process.env.RAVEN_TEST_NETWORK === '1') {
			await networkChecks();
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}

	console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
	process.exitCode = failures === 0 ? 0 : 1;
}

main().catch(err => {
	console.error(err);
	process.exitCode = 1;
});

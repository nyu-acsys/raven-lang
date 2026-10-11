'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// Exercise the compiled server over LSP, including configuration requests and refreshes.
async function main() {
	if (process.platform === 'win32') {
		console.log('Strict-mode server checks skipped: fixture needs an executable script.');
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-strict-'));
	const log = path.join(dir, 'calls.jsonl');
	const executable = path.join(dir, 'raven');
	fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const file = args[args.length - 1];
const text = fs.readFileSync(file, 'utf8');
const location = { file, start_line: 2, start_col: 1, end_line: 2, end_col: 5 };
if (text.includes('CRASH') && (!text.includes('VERIFY_CRASH') || !args.includes('--typeonly'))) process.exit(2);
if (text.includes('BAD_JSON')) { console.log('invalid JSON'); process.exit(0); }
if (text.includes('BAD_PAYLOAD')) { console.log('{}'); process.exit(0); }
if (text.includes('EMPTY_RESPONSE')) process.exit(0);
const errors = [];
if (args.includes('--strict')) errors.push({ ...location, kind: 'Warning', message: ['Assumed termination'] });
if (text.includes('VERIFY_ERROR') && !args.includes('--typeonly')) errors.push({ ...location, kind: 'Verification', message: ['Assertion failed'] });
if (text.includes('TYPE_ERROR')) errors.push({ ...location, kind: 'Type', message: ['Type mismatch'] });
if (text.includes('RELATED_ERROR') && !args.includes('--typeonly')) {
	const related = (message, line, source = file) => ({ ...location, file: source, start_line: line, end_line: line, kind: 'RelatedLoc', message: [message] });
	const included = ${JSON.stringify(path.join(dir, 'included.rav'))};
	errors.push(related('Inherited declaration', 1, included));
	if (args.includes('--strict')) errors.push({ ...location, kind: 'Warning', message: ['Second assumption'] });
	errors.push(related('Leading assertion', 3));
	errors.push({ ...location, kind: 'Verification', message: ['Assertion failed'] });
	errors.push(related('Trailing assertion', 5));
	if (args.includes('--strict')) errors.push({ ...location, kind: 'Warning', message: ['Third assumption'] });
	errors.push(related('Included assertion', 7, included));
}
const emit = () => console.log(JSON.stringify(args.includes('--lsp-annotations') ? { errors, annotations: [] } : errors));
if (text.includes('SLOW')) setTimeout(emit, 150); else emit();
`, { mode: 0o755 });
	const server = spawn(process.execPath, [path.join(__dirname, '../server/out/server.js'), '--stdio']);
	let nextId = 1;
	let buffer = Buffer.alloc(0);
	const pending = new Map();
	const refreshes = [];
	const stateUpdates = [];
	const annotations = [];
	const stateWaiters = [];
	const settings = new Map();
	const uri = pathToFileURL(path.join(dir, 'sample.rav')).toString();
	const otherUri = pathToFileURL(path.join(dir, 'other.rav')).toString();
	const defaultSettings = { strict: false, maxNumberOfProblems: 100, highlightRelatedLocations: true };
	const send = message => {
		const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
		server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		server.stdin.write(body);
	};
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = nextId++;
		const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 10000);
		pending.set(id, { resolve, reject, timer });
		send({ id, method, params });
	});
	server.stdout.on('data', data => {
		buffer = Buffer.concat([buffer, data]);
		while (true) {
			const headerEnd = buffer.indexOf('\r\n\r\n');
			if (headerEnd < 0) break;
			const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
			if (buffer.length < headerEnd + 4 + length) break;
			const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
			buffer = buffer.subarray(headerEnd + 4 + length);
			if (message.method && message.id !== undefined) {
				let result = null;
				if (message.method === 'workspace/configuration') {
					result = message.params.items.map(item => settings.get(item.scopeUri) ?? defaultSettings);
				} else if (message.method === 'workspace/diagnostic/refresh') {
					refreshes.shift()?.();
				}
				send({ id: message.id, result });
			} else if (message.method === 'raven/verificationState') {
				stateUpdates.push(message.params);
				for (const waiter of [...stateWaiters]) {
					if (waiter.uri === message.params.uri && waiter.state === message.params.state) {
						stateWaiters.splice(stateWaiters.indexOf(waiter), 1);
						clearTimeout(waiter.timer);
						waiter.resolve(message.params);
					}
				}
			} else if (message.method === 'raven/inheritedContracts') {
				annotations.push(message.params);
			} else if (!message.method && pending.has(message.id)) {
				const { resolve, reject, timer } = pending.get(message.id);
				pending.delete(message.id);
				clearTimeout(timer);
				if (message.error) reject(new Error(JSON.stringify(message.error)));
				else resolve(message.result);
			}
		}
	});
	let stderr = '';
	server.stderr.on('data', data => { stderr += data; });
	const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
	const diagnostics = async (resource = uri) => {
		const start = stateUpdates.length;
		const response = await request('textDocument/diagnostic', { textDocument: { uri: resource } });
		const updates = stateUpdates.slice(start).filter(update => update.uri === resource);
		assert.strictEqual(updates.length, 2);
		assert.strictEqual(updates[0].state, 'running');
		assert.notStrictEqual(updates[1].state, 'running');
		assert.strictEqual(updates[0].runId, updates[1].runId);
		assert.strictEqual(updates[0].version, updates[1].version);
		return response.items;
	};
	const waitForState = (uri, state) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`No ${state} state for ${uri}`)), 10000);
		stateWaiters.push({ uri, state, resolve, timer });
	});
	try {
		await request('initialize', {
			processId: process.pid,
			capabilities: { workspace: { configuration: true }, textDocument: { diagnostic: {}, publishDiagnostics: { relatedInformation: true } } }
		});
		send({ method: 'initialized', params: {} });
		send({ method: 'raven/executable', params: { executable, lspProtocol: 3 } });
		send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'raven', version: 1, text: 'program' } } });
		assert.deepStrictEqual(await diagnostics(), []);
		assert.strictEqual(calls().length, 2);
		assert.strictEqual(stateUpdates.at(-1).state, 'succeeded');
		assert(calls().every(args => !args.includes('--strict')));
		console.log('  ok   strict mode defaults off');

		settings.set(uri, { ...defaultSettings, strict: true });
		let refreshTimer;
		const refreshed = new Promise((resolve, reject) => {
			refreshTimer = setTimeout(() => reject(new Error('No diagnostics refresh')), 10000);
			refreshes.push(() => { clearTimeout(refreshTimer); resolve(); });
		});
		send({ method: 'workspace/didChangeConfiguration', params: { settings: {} } });
		await refreshed;
		const warnings = await diagnostics();
		assert.strictEqual(warnings.length, 1);
		assert.strictEqual(stateUpdates.at(-1).state, 'warnings');
		assert.strictEqual(warnings[0].severity, 2);
		assert.strictEqual(warnings[0].code, 'strict');
		assert.deepStrictEqual(warnings[0].range, { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } });
		assert.strictEqual(calls().length, 4);
		assert(calls().slice(-2).every(args => args.includes('--strict')));
		assert(calls().at(-2).includes('--typeonly'));
		assert(!calls().at(-1).includes('--typeonly'));
		console.log('  ok   settings refresh enables warnings without stopping verification or duplicating them');

		send({ method: 'textDocument/didOpen', params: { textDocument: { uri: otherUri, languageId: 'raven', version: 1, text: 'program' } } });
		assert.deepStrictEqual(await diagnostics(otherUri), []);
		assert(calls().slice(-2).every(args => !args.includes('--strict')));
		console.log('  ok   strict setting is resolved per document');

		send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'VERIFY_ERROR' }] } });
		assert.deepStrictEqual((await diagnostics()).map(d => d.severity), [2, 1]);
		assert.strictEqual(stateUpdates.at(-1).state, 'failed');
		console.log('  ok   warnings coexist with verification failures');

		send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: 'TYPE_ERROR' }] } });
		const count = calls().length;
		assert.deepStrictEqual((await diagnostics()).map(d => d.severity), [2, 1]);
		assert.strictEqual(calls().length, count + 1);
		assert.strictEqual(stateUpdates.at(-1).state, 'failed');
		console.log('  ok   type errors still stop before verification');

		send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 4 }, contentChanges: [{ text: 'program' }] } });
		send({ method: 'raven/executable', params: { executable, lspProtocol: 2 } });
		const legacyStart = calls().length;
		const legacy = await diagnostics();
		assert.strictEqual(legacy.length, 1);
		assert.strictEqual(stateUpdates.at(-1).state, 'unavailable');
		assert.strictEqual(legacy[0].severity, 2);
		assert.match(legacy[0].message, /newer Raven verifier/);
		assert.strictEqual(calls().length, legacyStart + 1);
		assert(calls().slice(legacyStart).every(args => !args.includes('--strict')));
		console.log('  ok   older verifiers report unavailable strict diagnostics without receiving the flag');
		settings.set(uri, defaultSettings);
		let disableTimer;
		const disabled = new Promise((resolve, reject) => {
			disableTimer = setTimeout(() => reject(new Error('No diagnostics refresh')), 10000);
			refreshes.push(() => { clearTimeout(disableTimer); resolve(); });
		});
		send({ method: 'workspace/didChangeConfiguration', params: { settings: {} } });
		await disabled;
		send({ method: 'raven/executable', params: { executable, lspProtocol: 3 } });
		assert.deepStrictEqual(await diagnostics(), []);
		assert(calls().slice(-2).every(args => !args.includes('--strict')));
		console.log('  ok   disabling strict mode clears warnings on the next check');
		const manualRefresh = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('No manual diagnostics refresh')), 10000);
			refreshes.push(() => { clearTimeout(timer); resolve(); });
		});
		send({ method: 'raven/verify', params: { uri, strict: true } });
		await manualRefresh;
		assert.deepStrictEqual(await diagnostics(otherUri), []);
		assert.deepStrictEqual((await diagnostics()).map(d => d.code), ['strict']);
		assert(calls().slice(-2).every(args => args.includes('--strict')));
		assert.strictEqual(settings.get(uri).strict, false);
		assert.deepStrictEqual(await diagnostics(), []);
		assert(calls().slice(-2).every(args => !args.includes('--strict')));
		console.log('  ok   manual strict verification overrides settings for one check of the requested file');

		const ordinaryRefresh = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('No manual diagnostics refresh')), 10000);
			refreshes.push(() => { clearTimeout(timer); resolve(); });
		});
		send({ method: 'raven/verify', params: { uri } });
		await ordinaryRefresh;
		assert.deepStrictEqual(await diagnostics(), []);
		assert(calls().slice(-2).every(args => !args.includes('--strict')));
		console.log('  ok   ordinary verification continues using the configured mode');
		for (const strict of [true, false]) {
			const resource = pathToFileURL(path.join(dir, strict ? 'strict-related.rav' : 'related.rav')).toString();
			settings.set(resource, { ...defaultSettings, strict });
			send({ method: 'textDocument/didOpen', params: { textDocument: { uri: resource, languageId: 'raven', version: 1, text: 'RELATED_ERROR' } } });
			const items = await diagnostics(resource);
			const warnings = items.filter(d => d.severity === 2);
			assert.strictEqual(warnings.length, strict ? 3 : 0);
			assert(warnings.every(d => d.relatedInformation === undefined));
			const failures = items.filter(d => d.severity === 1);
			assert.strictEqual(failures.length, 1);
			assert.deepStrictEqual(failures[0].relatedInformation.map(r => r.message), [
				'Inherited declaration', 'Leading assertion', 'Trailing assertion', 'Included assertion'
			]);
			const includedUri = pathToFileURL(path.join(dir, 'included.rav')).toString();
			assert.deepStrictEqual(failures[0].relatedInformation.map(r => r.location.uri), [
				includedUri, resource, resource, includedUri
			]);
			assert.deepStrictEqual(items.filter(d => d.severity === 3).map(d => d.range.start.line), [2, 4]);
			console.log(`  ok   leading and trailing related locations belong to the error with strict mode ${strict ? 'on' : 'off'}`);
		}
		for (const text of ['CRASH', 'VERIFY_CRASH', 'BAD_JSON', 'BAD_PAYLOAD', 'EMPTY_RESPONSE']) {
			const resource = pathToFileURL(path.join(dir, `${text}.rav`)).toString();
			send({ method: 'textDocument/didOpen', params: { textDocument: { uri: resource, languageId: 'raven', version: 1, text } } });
			const before = calls().length;
			assert.strictEqual((await diagnostics(resource)).length, 1);
			assert.strictEqual(calls().length, before + (text === 'VERIFY_CRASH' ? 2 : 1));
			assert.strictEqual(stateUpdates.at(-1).state, 'unavailable');
			assert(stateUpdates.at(-1).message);
		}
		console.log('  ok   crashes and invalid responses report unavailable without retrying verification');

		send({ method: 'raven/executable', params: { executable: path.join(dir, 'missing-verifier'), lspProtocol: 3 } });
		const beforeMissing = calls().length;
		assert.strictEqual((await diagnostics()).length, 1);
		assert.strictEqual(calls().length, beforeMissing);
		assert.strictEqual(stateUpdates.at(-1).state, 'unavailable');
		send({ method: 'raven/executable', params: { executable, lspProtocol: 3 } });
		console.log('  ok   a missing executable cannot produce a success state');

		const resource = pathToFileURL(path.join(dir, 'overlap.rav')).toString();
		for (const changeVersion of [true, false]) {
			send({ method: 'textDocument/didOpen', params: { textDocument: { uri: resource, languageId: 'raven', version: 1, text: 'SLOW' } } });
			const running = waitForState(resource, 'running');
			const oldResult = request('textDocument/diagnostic', { textDocument: { uri: resource } }).then(
				() => { throw new Error('Obsolete verification returned diagnostics'); }, error => error);
			const oldRun = await running;
			if (changeVersion) send({ method: 'textDocument/didChange', params: { textDocument: { uri: resource, version: 2 }, contentChanges: [{ text: 'program' }] } });
			const fresh = await request('textDocument/diagnostic', { textDocument: { uri: resource } });
			assert.deepStrictEqual(fresh.items, []);
			assert.match((await oldResult).message, /Verification superseded/);
			assert.deepStrictEqual(stateUpdates.filter(update => update.runId === oldRun.runId).map(update => update.state), ['running']);
			const latest = stateUpdates.at(-1);
			assert.strictEqual(latest.uri, resource);
			assert.strictEqual(latest.version, changeVersion ? 2 : 1);
			assert.strictEqual(latest.state, 'succeeded');
			assert(latest.runId > oldRun.runId);
			if (changeVersion) assert(annotations.filter(a => a.uri === resource).every(a => a.version === 2));
			send({ method: 'textDocument/didClose', params: { textDocument: { uri: resource } } });
		}
		console.log('  ok   obsolete versions and superseded runs cannot publish final state or diagnostics');
		assert.strictEqual(stderr, '');
		await request('shutdown', null);
		send({ method: 'exit' });
	} finally {
		server.kill();
		for (const { timer } of pending.values()) clearTimeout(timer);
		for (const { timer } of stateWaiters) clearTimeout(timer);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; });

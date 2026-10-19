'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VerificationProcesses } = require('../server/out/verificationProcesses');

async function waitFor(predicate) {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for verifier fixture');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
}

function isRunning(pid) {
	try {
		process.kill(pid, 0);
		// A killed orphan may briefly await reaping on Linux.
		if (process.platform === 'linux') {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
			if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
		}
		return true;
	} catch (error) {
		if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
		throw error;
	}
}

async function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-processes-'));
	const pool = new VerificationProcesses();
	const controllers = [];
	const results = [];
	const fixture = path.join(dir, 'fixture.js');
	fs.writeFileSync(fixture, `
const fs = require('fs');
const { spawn } = require('child_process');
const marker = process.argv[2];
const solver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(marker, JSON.stringify([process.pid, solver.pid]));
setInterval(() => {}, 1000);
`);
	const start = name => {
		const controller = new AbortController();
		controllers.push(controller);
		const marker = path.join(dir, name);
		const result = pool.run(process.execPath, [fixture, marker], {}, controller.signal).then(
			() => { throw new Error('Cancelled verifier succeeded'); }, error => error);
		results.push(result);
		return { controller, result, marker };
	};
	try {
		const first = start('first');
		const second = start('second');
		await waitFor(() => fs.existsSync(first.marker) && fs.existsSync(second.marker));
		const queued = start('queued');
		queued.controller.abort();
		assert.match((await queued.result).message, /cancelled/);
		assert(!fs.existsSync(queued.marker));
		const fresh = start('fresh');
		await new Promise(resolve => setTimeout(resolve, 100));
		assert(!fs.existsSync(fresh.marker));
		const firstPids = JSON.parse(fs.readFileSync(first.marker));
		first.controller.abort();
		assert.match((await first.result).message, /cancelled/);
		await waitFor(() => firstPids.every(pid => !isRunning(pid)));
		await waitFor(() => fs.existsSync(fresh.marker));
		assert(!fs.existsSync(queued.marker));
		console.log('  ok   cancellation kills verifier and solver, frees a slot, and skips cancelled queued checks');

		const remainingPids = [second, fresh].flatMap(run => JSON.parse(fs.readFileSync(run.marker)));
		second.controller.abort();
		fresh.controller.abort();
		await Promise.all([second.result, fresh.result, pool.waitForIdle()]);
		await waitFor(() => remainingPids.every(pid => !isRunning(pid)));

		const signal = new AbortController().signal;
		assert.strictEqual(await pool.run(process.execPath, ['-e', 'process.stdout.write("ok")'], {}, signal), 'ok');
		await assert.rejects(pool.run(path.join(dir, 'missing'), [], {}, signal), /ENOENT/);
		await assert.rejects(pool.run(process.execPath, ['-e', 'process.stderr.write("failure"); process.exit(2)'], {}, signal), /code 2: failure/);
		await assert.rejects(pool.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))'], {}, signal), /output limit/);
		await pool.waitForIdle();
		console.log('  ok   success, launch failures, nonzero exits and output limits preserve process-slot cleanup');
	} finally {
		controllers.forEach(controller => controller.abort());
		await Promise.all(results);
		await pool.waitForIdle();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// A Raven server (`raven --server`) that answers each request with its arguments. Its
// first argument selects a behavior: `fail` exits with an error, `crash-once` ends the
// first server it reaches, `hang` never answers, after starting a solver, and `wait`
// answers only its cancellation.
async function servers() {
	if (process.platform === 'win32') {
		console.log('Raven server checks skipped: fixture needs an executable script.');
		return;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven-servers-'));
	const starts = path.join(dir, 'starts');
	const crashed = path.join(dir, 'crashed');
	const executable = path.join(dir, 'raven');
	fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs');
const { spawn } = require('child_process');
fs.appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
let buffer = '';
let waiting;
process.stdin.on('data', data => {
	buffer += data;
	let newline;
	while ((newline = buffer.indexOf('\\n')) >= 0) {
		const message = JSON.parse(buffer.slice(0, newline));
		buffer = buffer.slice(newline + 1);
		if ('cancel' in message) {
			if (waiting === message.cancel) { process.stdout.write(JSON.stringify({ id: waiting, cancelled: true }) + '\\n'); waiting = undefined; }
			continue;
		}
		const { id, cwd, args } = message;
		if (args[0] === 'wait') { waiting = id; continue; }
		if (args[0] === 'crash-once' && !fs.existsSync(${JSON.stringify(crashed)})) {
			fs.writeFileSync(${JSON.stringify(crashed)}, '');
			process.exit(3);
		}
		if (args[0] === 'hang') {
			const solver = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
			fs.writeFileSync(args[1], JSON.stringify([process.pid, solver.pid]));
			continue;
		}
		const exit = args[0] === 'fail' ? 1 : 0;
		process.stdout.write(JSON.stringify({ id, exit, stdout: JSON.stringify({ cwd, args }), stderr: exit ? 'failure' : '' }) + '\\n');
	}
});
`);
	fs.chmodSync(executable, 0o755);
	const pool = new VerificationProcesses();
	const started = () => fs.readFileSync(starts, 'utf8').trim().split('\n').map(Number);
	const signal = new AbortController().signal;
	try {
		const echo = async args => JSON.parse(await pool.serve(executable, args, dir, process.env, signal));
		assert.deepStrictEqual(await echo(['a']), { cwd: dir, args: ['a'] });
		assert.deepStrictEqual(await echo(['b']), { cwd: dir, args: ['b'] });
		assert.strictEqual(started().length, 1);
		await assert.rejects(pool.serve(executable, ['fail'], dir, process.env, signal), /code 1: failure/);
		assert.deepStrictEqual(await echo(['c']), { cwd: dir, args: ['c'] });
		assert.strictEqual(started().length, 1);
		console.log('  ok   a server answers several runs, also after a failed one');

		assert.deepStrictEqual(await echo(['crash-once']), { cwd: dir, args: ['crash-once'] });
		assert.strictEqual(started().length, 2);
		await waitFor(() => !isRunning(started()[0]));
		console.log('  ok   a server that dies is replaced, and the run tried again');

		const controller = new AbortController();
		const marker = path.join(dir, 'hung');
		const hung = pool.serve(executable, ['hang', marker], dir, process.env, controller.signal).then(
			() => { throw new Error('Cancelled run succeeded'); }, error => error);
		await waitFor(() => fs.existsSync(marker));
		const pids = JSON.parse(fs.readFileSync(marker));
		controller.abort();
		assert.match((await hung).message, /cancelled/);
		await waitFor(() => pids.every(pid => !isRunning(pid)));
		assert.deepStrictEqual(await echo(['d']), { cwd: dir, args: ['d'] });
		assert.strictEqual(started().length, 3);
		console.log('  ok   cancelling a run stops its server and solver, and the next run starts another');

		const waitController = new AbortController();
		const waited = pool.serve(executable, ['wait'], dir, process.env, waitController.signal).then(
			() => { throw new Error('Cancelled run succeeded'); }, error => error);
		await new Promise(resolve => setTimeout(resolve, 50));
		waitController.abort();
		assert.match((await waited).message, /cancelled/);
		assert.deepStrictEqual(await echo(['f']), { cwd: dir, args: ['f'] });
		assert.strictEqual(started().length, 3);
		console.log('  ok   a server that answers a cancellation is kept for the next run');

		const otherEnv = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
		const previous = started()[2];
		assert.deepStrictEqual(JSON.parse(await pool.serve(executable, ['e'], dir, otherEnv, signal)), { cwd: dir, args: ['e'] });
		assert.strictEqual(started().length, 4);
		await waitFor(() => !isRunning(previous));
		await pool.stopServers();
		await waitFor(() => !isRunning(started()[3]));
		console.log('  ok   another environment gets its own server, and the old ones are stopped');
	} finally {
		await pool.stopServers();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

module.exports = { waitFor, isRunning };
if (require.main === module) main().then(servers).catch(error => { console.error(error); process.exitCode = 1; });

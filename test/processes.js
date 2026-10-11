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

module.exports = { waitFor, isRunning };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

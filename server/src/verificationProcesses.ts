import { spawn, execFile, type ChildProcess, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** How long a server may take to answer a cancellation before it is stopped. */
const CANCELLATION_GRACE_MS = 2000;

function cancelled(): Error { return new Error('Verification cancelled'); }

/** Kills [child] with the Z3 processes it started, which share its Unix process group. */
function terminateGroup(child: ChildProcess): Promise<Error | undefined> {
	const pid = child.pid;
	if (pid === undefined) return Promise.resolve(undefined);
	return new Promise(done => {
		if (process.platform === 'win32') {
			const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
			execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
				if (error && child.exitCode === null && child.signalCode === null) {
					child.kill('SIGKILL');
					done(error);
				} else done(undefined);
			});
		} else {
			try { process.kill(-pid, 'SIGKILL'); done(undefined); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') done(undefined);
				else { child.kill('SIGKILL'); done(error as Error); }
			}
		}
	});
}

interface ServerAnswer {
	id: number, exit?: number, stdout?: string, stderr?: string, error?: string, cancelled?: boolean
}

/**
 * A `raven --server` process (protocol 4), which answers one request at a time and keeps
 * the checked library between them.
 */
class RavenServer {
	private readonly child: ChildProcess;
	private buffer = '';
	private pending: { id: number, resolve: (answer: ServerAnswer) => void, reject: (error: Error) => void } | undefined;
	private exited = false;
	private nextId = 0;

	constructor(readonly key: string, executable: string, env: NodeJS.ProcessEnv | undefined) {
		this.child = spawn(executable, ['--server'], {
			env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']
		});
		this.child.stdout!.setEncoding('utf8');
		this.child.stdout!.on('data', (data: string) => this.receive(data));
		this.child.on('error', error => this.fail(error));
		this.child.on('close', code => this.fail(new Error(`The Raven server exited with code ${code}`)));
		this.child.stdin!.on('error', error => this.fail(error));
	}

	get alive(): boolean { return !this.exited; }

	private fail(error: Error): void {
		this.exited = true;
		const pending = this.pending;
		this.pending = undefined;
		pending?.reject(error);
	}

	private receive(data: string): void {
		this.buffer += data;
		if (this.buffer.length > 4 * MAX_OUTPUT_BYTES) {
			this.fail(new Error('Raven output exceeded the output limit'));
			void this.stop();
			return;
		}
		let newline: number;
		while ((newline = this.buffer.indexOf('\n')) >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			const pending = this.pending;
			let answer: ServerAnswer | undefined;
			try { answer = JSON.parse(line) as ServerAnswer; } catch { answer = undefined; }
			if (!pending) continue;
			if (!answer || answer.id !== pending.id) {
				this.fail(new Error(`Unexpected answer from the Raven server: ${line.slice(0, 200)}`));
				void this.stop();
				continue;
			}
			this.pending = undefined;
			pending.resolve(answer);
		}
	}

	/** The answer to a run with [args] in the directory [cwd]. */
	request(cwd: string, args: string[]): Promise<ServerAnswer> {
		return new Promise((resolve, reject) => {
			if (this.exited || this.pending) { reject(new Error('The Raven server is not available')); return; }
			const id = this.nextId++;
			this.pending = { id, resolve, reject };
			this.child.stdin!.write(JSON.stringify({ id, cwd, args }) + '\n');
		});
	}

	/** Asks the server to stop the run it is answering, which it then answers as cancelled. */
	cancel(): void {
		if (this.exited || !this.pending) return;
		this.child.stdin!.write(JSON.stringify({ cancel: this.pending.id }) + '\n');
	}

	async stop(): Promise<void> {
		this.exited = true;
		await terminateGroup(this.child);
	}
}

/** Limit verifier processes; queued requests can be cancelled before they launch. */
export class VerificationProcesses {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	private readonly idleWaiters: (() => void)[] = [];

	/** The servers waiting for a request, by executable and environment. */
	private idle: RavenServer[] = [];
	private readonly busy = new Set<RavenServer>();

	constructor(private readonly limit = 2) {
		if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid verification process limit');
	}

	private acquire(signal: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = () => {
				signal.removeEventListener('abort', abort);
				this.active++;
				resolve();
			};
			const abort = () => {
				const index = this.queue.indexOf(start);
				if (index >= 0) this.queue.splice(index, 1);
				reject(cancelled());
			};
			if (signal.aborted) { reject(cancelled()); return; }
			if (this.active < this.limit) start();
			else {
				this.queue.push(start);
				signal.addEventListener('abort', abort, { once: true });
			}
		});
	}

	private release(): void {
		this.active--;
		this.queue.shift()?.();
		if (this.active === 0) this.idleWaiters.splice(0).forEach(resolve => resolve());
	}

	waitForIdle(): Promise<void> {
		return this.active === 0 ? Promise.resolve()
			: new Promise(resolve => this.idleWaiters.push(resolve));
	}

	/**
	 * The output of a run of a Raven server (protocol 4) with [args] in [cwd]. A server that
	 * fails is replaced, and the run is tried once more on the new one. A cancelled run is
	 * cancelled in its server, which is stopped only if it does not answer in time.
	 */
	async serve(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, signal: AbortSignal): Promise<string> {
		const key = JSON.stringify([executable, env?.PATH ?? '']);
		// Servers of another executable, or with another solver, are no longer needed.
		for (const server of this.idle.filter(s => s.key !== key)) void server.stop();
		this.idle = this.idle.filter(s => s.key === key && s.alive);
		await this.acquire(signal);
		try {
			for (let attempt = 0; ; attempt++) {
				if (signal.aborted) throw cancelled();
				const server = this.idle.pop() ?? new RavenServer(key, executable, env);
				this.busy.add(server);
				let grace: NodeJS.Timeout | undefined;
				const abort = () => {
					server.cancel();
					grace = setTimeout(() => { void server.stop(); }, CANCELLATION_GRACE_MS);
				};
				signal.addEventListener('abort', abort, { once: true });
				try {
					const answer = await server.request(cwd, args);
					clearTimeout(grace);
					this.idle.push(server);
					if (signal.aborted) throw cancelled();
					if (answer.error !== undefined) throw new Error(`Raven server: ${answer.error}`);
					if ((answer.stdout ?? '').length > MAX_OUTPUT_BYTES) throw new Error('Raven stdout exceeded the output limit');
					if (answer.exit !== 0) throw new Error(`Raven exited with code ${answer.exit}: ${answer.stderr ?? ''}`);
					return answer.stdout ?? '';
				} catch (error) {
					clearTimeout(grace);
					if (signal.aborted) throw cancelled();
					if (server.alive || attempt > 0) throw error;
				} finally {
					signal.removeEventListener('abort', abort);
					this.busy.delete(server);
				}
			}
		} finally {
			this.release();
		}
	}

	/** Stops the servers. */
	async stopServers(): Promise<void> {
		const servers = [...this.idle, ...this.busy];
		this.idle = [];
		await Promise.all(servers.map(server => server.stop()));
	}

	async run(executable: string, args: string[], options: SpawnOptionsWithoutStdio, signal: AbortSignal): Promise<string> {
		await this.acquire(signal);
		try {
			if (signal.aborted) throw cancelled();
			return await new Promise<string>((resolve, reject) => {
				// A separate Unix process group includes the Z3 processes Raven starts.
				const child = spawn(executable, args, {
					...options, detached: process.platform !== 'win32', windowsHide: true,
					stdio: ['ignore', 'pipe', 'pipe']
				});
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				let stdoutBytes = 0;
				let stderrBytes = 0;
				let failure: Error | undefined;
				let termination: Promise<void> | undefined;
				const terminate = () => {
					if (termination || child.pid === undefined) return;
					termination = terminateGroup(child).then(error => { if (error) failure ??= error; });
				};
				signal.addEventListener('abort', terminate, { once: true });
				child.stdout.on('data', (data: Buffer) => {
					stdoutBytes += data.length;
					if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(data);
					else { failure ??= new Error('Raven stdout exceeded the output limit'); terminate(); }
				});
				child.stderr.on('data', (data: Buffer) => {
					stderrBytes += data.length;
					if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(data);
					else { failure ??= new Error('Raven stderr exceeded the output limit'); terminate(); }
				});
				child.on('error', error => { failure = error; });
				child.on('close', async (code, exitSignal) => {
					signal.removeEventListener('abort', terminate);
					await termination;
					if (signal.aborted) reject(cancelled());
					else if (failure) reject(failure);
					else if (code !== 0) reject(new Error(`Raven exited with ${exitSignal ?? `code ${code}`}: ${Buffer.concat(stderr).toString()}`));
					else resolve(Buffer.concat(stdout).toString());
				});
			});
		} finally {
			this.release();
		}
	}
}

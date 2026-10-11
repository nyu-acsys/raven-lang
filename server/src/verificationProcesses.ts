import { spawn, execFile, type SpawnOptionsWithoutStdio } from 'node:child_process';
import * as path from 'node:path';

const MAX_OUTPUT_BYTES = 1024 * 1024;

function cancelled(): Error { return new Error('Verification cancelled'); }

/** Limit verifier processes; queued requests can be cancelled before they launch. */
export class VerificationProcesses {
	private active = 0;
	private readonly queue: (() => void)[] = [];
	private readonly idleWaiters: (() => void)[] = [];

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
					const pid = child.pid;
					termination = new Promise<void>((done) => {
						if (process.platform === 'win32') {
							const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
							execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => {
								if (error && child.exitCode === null && child.signalCode === null) {
									failure ??= error;
									child.kill('SIGKILL');
								}
								done();
							});
						} else {
							try { process.kill(-pid, 'SIGKILL'); }
							catch (error) {
								if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
									failure ??= error as Error;
									child.kill('SIGKILL');
								}
							}
							done();
						}
					});
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

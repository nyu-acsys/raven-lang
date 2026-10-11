export type VerificationState = 'unchecked' | 'outdated' | 'running' | 'succeeded' | 'warnings' | 'failed' | 'unavailable';

export interface VerificationUpdate {
	uri: string;
	version: number;
	runId: number;
	state: Exclude<VerificationState, 'unchecked' | 'outdated'>;
	message?: string;
}

interface DocumentState {
	version: number;
	runId: number;
	state: VerificationState;
	message?: string;
}

export class VerificationTracker {
	private readonly documents = new Map<string, DocumentState>();

	get(uri: string, version: number): { state: VerificationState, message?: string } {
		const entry = this.documents.get(uri);
		if (!entry) return { state: 'unchecked' };
		return entry.version === version ? entry : { state: 'outdated' };
	}

	update(update: VerificationUpdate, currentVersion: number): boolean {
		if (update.version !== currentVersion) return false;
		const previous = this.documents.get(update.uri);
		if (update.state === 'running') {
			if (previous && update.runId <= previous.runId) return false;
		} else if (!previous || previous.state !== 'running' || previous.runId !== update.runId) {
			return false;
		}
		this.documents.set(update.uri, update);
		return true;
	}

	invalidate(uri: string, version: number): void {
		const previous = this.documents.get(uri);
		if (previous) this.documents.set(uri, { version, runId: previous.runId, state: 'outdated' });
	}

	unavailable(uri: string, version: number, message: string): void {
		this.documents.set(uri, { version, runId: this.documents.get(uri)?.runId ?? 0, state: 'unavailable', message });
	}

	close(uri: string): void { this.documents.delete(uri); }
	clear(): void { this.documents.clear(); }
}

export const verificationPresentation: Record<VerificationState, { text: string, color: string, tooltip: string }> = {
	unchecked: { text: '$(circle-outline) Raven: Not checked', color: 'descriptionForeground', tooltip: 'This document has no verification result yet.' },
	outdated: { text: '$(history) Raven: Result outdated', color: 'descriptionForeground', tooltip: 'The document or verification configuration changed since the last check.' },
	running: { text: '$(sync~spin) Raven: Verifying', color: 'charts.blue', tooltip: 'Raven is checking this document.' },
	succeeded: { text: '$(check) Raven: Verified', color: 'charts.green', tooltip: 'Verification completed successfully for this document version.' },
	warnings: { text: '$(warning) Raven: Verified with warnings', color: 'charts.yellow', tooltip: 'Verification completed successfully with strict-mode warnings.' },
	failed: { text: '$(error) Raven: Verification failed', color: 'charts.red', tooltip: 'Raven reported an error for this document version.' },
	unavailable: { text: '$(warning) Raven: Verification unavailable', color: 'charts.orange', tooltip: 'Raven could not complete verification.' }
};

import * as path from 'path';
import * as vscode from 'vscode';

export interface DependencyUpdate { uri: string, version: number, runId: number, dependencies: string[] }

/** Share directory watchers across documents, including dependencies outside the workspace. */
export class DependencyWatchers implements vscode.Disposable {
	private readonly documents = new Map<string, { runId: number, dependencies: string[] }>();
	private readonly directories = new Map<string, { watcher: vscode.FileSystemWatcher, files: Set<string> }>();

	constructor(private readonly changed: (uri: vscode.Uri, type: number) => void) { }

	has(uri: vscode.Uri): boolean {
		return this.directories.get(path.dirname(uri.fsPath))?.files.has(uri.toString()) ?? false;
	}

	update(update: DependencyUpdate): void {
		if ((this.documents.get(update.uri)?.runId ?? -1) > update.runId) return;
		this.documents.set(update.uri, { runId: update.runId, dependencies: update.dependencies });
		this.sync();
	}

	close(uri: string): void {
		this.documents.delete(uri);
		this.sync();
	}

	private sync(): void {
		const wanted = new Map<string, Set<string>>();
		for (const { dependencies } of this.documents.values()) {
			for (const dependency of dependencies) {
				const uri = vscode.Uri.parse(dependency);
				if (uri.scheme !== 'file') continue;
				const dir = path.dirname(uri.fsPath);
				if (!wanted.has(dir)) wanted.set(dir, new Set());
				wanted.get(dir)!.add(uri.toString());
			}
		}
		for (const [dir, entry] of this.directories) {
			const files = wanted.get(dir);
			if (files) entry.files = files;
			else { entry.watcher.dispose(); this.directories.delete(dir); }
		}
		for (const [dir, files] of wanted) {
			if (this.directories.has(dir)) continue;
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*'));
			const changed = (uri: vscode.Uri, type: number) => {
				if (this.has(uri)) this.changed(uri, type);
			};
			watcher.onDidCreate(uri => changed(uri, 1));
			watcher.onDidChange(uri => changed(uri, 2));
			watcher.onDidDelete(uri => changed(uri, 3));
			this.directories.set(dir, { watcher, files });
		}
	}

	dispose(): void {
		for (const { watcher } of this.directories.values()) watcher.dispose();
		this.directories.clear();
		this.documents.clear();
	}
}

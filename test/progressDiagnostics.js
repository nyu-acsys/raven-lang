'use strict';

const assert = require('assert');
const Module = require('module');
const { URI } = require('vscode-uri');

class EventEmitter {
	listeners = new Set();
	event = listener => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};
	fire(value) { for (const listener of this.listeners) listener(value); }
}
class Range {
	constructor(line, character, endLine, endCharacter) {
		this.start = { line, character };
		this.end = { line: endLine, character: endCharacter };
	}
	isEqual(other) {
		return this.start.line === other.start.line && this.start.character === other.start.character
			&& this.end.line === other.end.line && this.end.character === other.end.character;
	}
}
const changed = new EventEmitter();
const closed = new EventEmitter();
const stateChanged = new EventEmitter();
const State = { Stopped: 1, Running: 2, Starting: 3 };
const notifications = new Map();
// The diagnostics of the previous check, which the editor still shows.
const pulled = new Map();
let collection;
const vscode = {
	Uri: URI, Range,
	workspace: { textDocuments: [], onDidChangeTextDocument: changed.event, onDidCloseTextDocument: closed.event },
	languages: {
		createDiagnosticCollection() {
			const entries = new Map();
			collection = {
				entries,
				set: (uri, diagnostics) => entries.set(uri.toString(), diagnostics),
				delete: uri => entries.delete(uri.toString()),
				clear: () => entries.clear(),
				dispose: () => entries.clear()
			};
			return collection;
		},
		getDiagnostics: uri => [...(pulled.get(uri.toString()) ?? []), ...(collection.entries.get(uri.toString()) ?? [])]
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscode;
	if (request === 'vscode-languageclient') return { State };
	return originalLoad.call(this, request, parent, isMain);
};
const { registerProgressDiagnostics } = require('../client/out/progressDiagnostics');
Module._load = originalLoad;

const client = {
	onDidChangeState: stateChanged.event,
	onNotification(method, handler) {
		notifications.set(method, handler);
		return { dispose: () => notifications.delete(method) };
	},
	protocol2CodeConverter: {
		asDiagnostics: async diagnostics => diagnostics.map(d => ({
			message: d.message, range: new Range(d.range.start.line, d.range.start.character, d.range.end.line, d.range.end.character)
		}))
	}
};
const context = { subscriptions: [] };
const progress = registerProgressDiagnostics(context, client);

const document = { uri: URI.parse('file:///tests/progress.rav'), version: 1 };
vscode.workspace.textDocuments.push(document);
const uri = document.uri.toString();
const error = (line, message) => ({ message, range: { start: { line, character: 0 }, end: { line, character: 4 } } });
const report = (runId, diagnostics, version = document.version) =>
	notifications.get('raven/progressDiagnostics')({ uri, version, runId, diagnostics });
const shown = () => (collection.entries.get(uri) ?? []).map(d => d.message);

(async () => {
	pulled.set(uri, [{ message: 'old', range: new Range(1, 0, 1, 4) }]);
	await report(1, [error(1, 'old'), error(3, 'new')]);
	assert.deepStrictEqual(shown(), ['new']);
	await report(1, [error(1, 'old'), error(3, 'new'), error(5, 'newer')]);
	assert.deepStrictEqual(shown(), ['new', 'newer']);
	await report(0, [error(7, 'stale run')]);
	assert.deepStrictEqual(shown(), ['new', 'newer']);
	await report(1, [error(9, 'stale version')], 0);
	assert.deepStrictEqual(shown(), ['new', 'newer']);
	console.log('  ok   errors found so far are shown unless the previous result shows them, from the latest run only');

	progress.onVerificationState({ uri, version: 1, runId: 1, state: 'failed' });
	assert.deepStrictEqual(shown(), []);
	await report(2, [error(3, 'again')]);
	progress.onVerificationState({ uri, version: 1, runId: 3, state: 'running' });
	assert.deepStrictEqual(shown(), []);
	await report(3, [error(3, 'edited')]);
	changed.fire({ document, contentChanges: [{}] });
	assert.deepStrictEqual(shown(), []);
	await report(3, [error(3, 'closed')]);
	closed.fire(document);
	assert.deepStrictEqual(shown(), []);
	await report(4, [error(3, 'restarted')]);
	stateChanged.fire({ newState: State.Starting });
	assert.deepStrictEqual(shown(), []);
	console.log('  ok   the result of the run, a new run, edits, closing and restarts drop them');
})().catch(error => { console.error(error); process.exitCode = 1; });

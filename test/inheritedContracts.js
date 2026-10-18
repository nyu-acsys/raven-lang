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
	dispose() { this.listeners.clear(); }
}
class Range {
	constructor(line, character, endLine, endCharacter) {
		this.start = { line, character };
		this.end = { line: endLine, character: endCharacter };
	}
	contains(position) {
		const compare = (a, b) => a.line - b.line || a.character - b.character;
		return compare(this.start, position) <= 0 && compare(position, this.end) <= 0;
	}
}
const changed = new EventEmitter();
const closed = new EventEmitter();
const stateChanged = new EventEmitter();
const State = { Stopped: 1, Running: 2, Starting: 3 };
const providers = {};
const notifications = new Map();
const vscode = {
	Uri: URI, Range, EventEmitter,
	MarkdownString: class { constructor(value) { this.value = value; } },
	CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
	Hover: class { constructor(contents, range) { this.contents = contents; this.range = range; } },
	workspace: {
		textDocuments: [],
		onDidChangeTextDocument: changed.event,
		onDidCloseTextDocument: closed.event
	},
	languages: {
		registerCodeLensProvider(_selector, provider) {
			providers.lenses = provider;
			return { dispose: () => { delete providers.lenses; } };
		},
		registerHoverProvider(_selector, provider) {
			providers.hover = provider;
			return { dispose: () => { delete providers.hover; } };
		}
	}
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscode;
	if (request === 'vscode-languageclient') return { State };
	return originalLoad.call(this, request, parent, isMain);
};
const { registerInheritedContracts } = require('../client/out/inheritedContracts');
Module._load = originalLoad;

const client = {
	onDidChangeState: stateChanged.event,
	onNotification(method, handler) {
		assert(!notifications.has(method), `Duplicate notification handler: ${method}`);
		notifications.set(method, handler);
		return { dispose: () => notifications.delete(method) };
	}
};
const context = { subscriptions: [] };
const display = registerInheritedContracts(context, client);
context.subscriptions.push(
	client.onNotification('raven/verificationState', display.onVerificationState),
	client.onNotification('raven/verificationInvalidated', display.onVerificationInvalidated));
const emit = (method, params) => notifications.get(method)?.(params);
const open = (name, version = 1) => {
	const document = { uri: URI.parse(`file:///tests/${name}.rav`), languageId: 'raven', version };
	vscode.workspace.textDocuments.push(document);
	return document;
};
const range = line => new Range(line, 0, line, 10);
const publish = (document, runId, version = document.version, text = 'n >= 0', keyword = 'ensures') => emit('raven/inheritedContracts', {
	uri: document.uri.toString(), version, runId,
	contracts: [{ range: range(0), source: 'I.bound', sourceLocation: { uri: 'file:///tests/interface.rav', range: range(1) },
		clauses: [{ keyword, text, failing: false, location: { uri: 'file:///tests/interface.rav', range: range(2) } }] }],
	modules: [{ range: range(3), members: [{ origin: 'I', text: 'func bound() returns (n: Int)',
		location: { uri: 'file:///tests/interface.rav', range: range(1) } }] }]
});
const start = (document, runId) => emit('raven/verificationState', {
	uri: document.uri.toString(), version: document.version, runId, state: 'running'
});
const invalidated = (document, runId, version = document.version) => emit('raven/verificationInvalidated', {
	uri: document.uri.toString(), version, runId
});
const lenses = document => providers.lenses.provideCodeLenses(document);
const hover = (document, line) => providers.hover.provideHover(document, { line, character: 1 });
const empty = document => {
	assert.deepStrictEqual(lenses(document), []);
	assert.strictEqual(hover(document, 0), undefined);
	assert.strictEqual(hover(document, 3), undefined);
};
const visible = (document, text = 'n >= 0') => {
	assert.strictEqual(lenses(document).length, 1);
	assert(lenses(document)[0].command.title.includes(text));
	assert(hover(document, 0).contents.value.includes(text));
	assert(hover(document, 3).contents.value.includes('func bound()'));
};

try {
	const opensDocument = open('opens');
	start(opensDocument, 1);
	publish(opensDocument, 1, opensDocument.version, '{}', 'opens');
	assert(lenses(opensDocument)[0].command.title.includes('opens {}'));
	assert(hover(opensDocument, 0).contents.value.includes('opens {}'));
	console.log('  ok   opens-only inherited contracts appear in code lenses and hovers');

	const statusDocument = open('status');
	start(statusDocument, 1);
	emit('raven/inheritedContracts', {
		uri: statusDocument.uri.toString(), version: statusDocument.version, runId: 1, contracts: [],
		members: ['verified', 'failed', 'timeout', 'skipped', 'unknown'].map((status, line) =>
			({ range: range(line), name: `p${line}`, kind: 'proc', status }))
	});
	const titles = (document, verify) => lenses(document).map(lens => lens.command.title)
		.filter(title => title.startsWith('Verify') === verify);
	assert.deepStrictEqual(titles(statusDocument, false), ['✓ verified', '✗ failed', '⏱ timed out', '– skipped']);
	assert(lenses(statusDocument).find(lens => lens.command.title === '✗ failed')
		.command.tooltip.startsWith('p1: Raven could not verify this proc'));
	assert.strictEqual(lenses(statusDocument).at(-1).command.title, '– skipped');
	assert.deepStrictEqual(titles(statusDocument, true), Array(5).fill('Verify this'));
	const verifyP2 = lenses(statusDocument).find(lens => lens.command.arguments?.[1] === 'p2');
	assert.deepStrictEqual(verifyP2.command.arguments, [statusDocument.uri.toString(), 'p2']);
	assert.strictEqual(verifyP2.command.command, 'raven.verifyThis');
	emit('raven/verificationState', {
		uri: statusDocument.uri.toString(), version: statusDocument.version, runId: 1, state: 'failed', focus: 'p2'
	});
	const focused = lenses(statusDocument).filter(lens => lens.command.title.startsWith('Verify'));
	assert.deepStrictEqual(focused.map(lens => lens.command.title),
		['Verify this', 'Verify this', 'Verify all', 'Verify this', 'Verify this']);
	assert.strictEqual(focused[2].command.command, 'raven.verifyAll');
	emit('raven/verificationState', {
		uri: statusDocument.uri.toString(), version: statusDocument.version, runId: 1, state: 'failed'
	});
	assert.deepStrictEqual(titles(statusDocument, true), Array(5).fill('Verify this'));
	emit('raven/inheritedContracts', {
		uri: statusDocument.uri.toString(), version: statusDocument.version, runId: 1, contracts: [],
		members: [
			{ range: range(0), name: 'M', kind: 'module', status: 'failed', counts: { verified: 9, timeout: 1, failed: 2 } },
			{ range: range(0), name: 'M.compCommute', kind: 'lemma', status: 'failed', inherited: true }
		]
	});
	assert.deepStrictEqual(lenses(statusDocument).map(lens => lens.command.title),
		['Verify this', '✗ 2 failed, 1 timed out, 9 verified']);
	assert(lenses(statusDocument).at(-1).command.tooltip.endsWith('Inherited:\n✗ failed: lemma compCommute'));
	console.log('  ok   code lenses show the status of members, ignoring unknown ones, and summarize modules');
	emit('raven/inheritedContracts', {
		uri: statusDocument.uri.toString(), version: statusDocument.version, runId: 1, contracts: [],
		members: [
			{ range: range(0), name: 'L', kind: 'module' },
			{ range: range(1), name: 'L.lseg', kind: 'pred' },
			{ range: range(2), name: 'L.valid', kind: 'pred', status: 'verified' },
			{ range: range(3), name: 'L.len', kind: 'func', checked: true },
			{ range: range(4), name: 'L.free_fn', kind: 'func' },
			{ range: range(5), name: 'N', kind: 'module' },
			{ range: range(6), name: 'N.f', kind: 'field' }
		]
	});
	assert.deepStrictEqual(lenses(statusDocument).filter(lens => lens.command.title === 'Verify this')
		.map(lens => lens.command.arguments[1]), ['L', 'L.valid', 'L.len']);
	console.log('  ok   members and modules get a Verify this lens if there is something to verify, and the focus a Verify all one');

	let refreshes = 0;
	context.subscriptions.push(providers.lenses.onDidChangeCodeLenses(() => refreshes++));
	let document = open('main');
	publish(document, 1);
	empty(document);
	start(document, 1);
	publish(document, 1);
	visible(document);
	changed.fire({ document, contentChanges: [] });
	visible(document);
	const beforeEdit = refreshes;
	document.version = 2;
	// Providers also reject stale positions before the change listener runs.
	empty(document);
	changed.fire({ document, contentChanges: [{ text: 'changed' }] });
	assert(refreshes > beforeEdit);
	empty(document);
	publish(document, 1, 1);
	empty(document);
	start(document, 2);
	publish(document, 2);
	visible(document);
	console.log('  ok   edits clear code lenses and both hover caches; obsolete versions stay rejected');

	const other = open('other');
	start(other, 3);
	publish(other, 3);
	invalidated(document, 2, 1);
	visible(document);
	invalidated(document, 2);
	empty(document);
	publish(document, 2);
	empty(document);
	visible(other);
	start(document, 4);
	publish(document, 4, document.version, 'n >= 1');
	visible(document, 'n >= 1');
	invalidated(document, 2);
	visible(document, 'n >= 1');
	start(document, 5);
	empty(document);
	publish(document, 4);
	empty(document);
	publish(document, 5);
	visible(document);
	console.log('  ok   dependency invalidation is per document and old runs cannot restore cleared annotations');

	vscode.workspace.textDocuments = vscode.workspace.textDocuments.filter(d => d !== document);
	closed.fire(document);
	empty(document);
	publish(document, 5);
	empty(document);
	document = open('main');
	publish(document, 1);
	empty(document);
	start(document, 6);
	publish(document, 5);
	empty(document);
	publish(document, 6);
	visible(document);
	visible(other);
	console.log('  ok   closing forgets annotations and run metadata, including close/reopen with reused versions');

	stateChanged.fire({ newState: State.Starting });
	empty(document);
	empty(other);
	publish(document, 6);
	empty(document);
	start(document, 1);
	publish(document, 6);
	empty(document);
	publish(document, 1);
	visible(document);
	stateChanged.fire({ newState: State.Stopped });
	empty(document);
	publish(document, 1);
	empty(document);
	console.log('  ok   restart and shutdown clear all annotations and allow fresh server run IDs');
} finally {
	context.subscriptions.forEach(subscription => subscription.dispose());
}
assert.strictEqual(notifications.size, 0);
assert.strictEqual(changed.listeners.size + closed.listeners.size + stateChanged.listeners.size, 0);
assert.deepStrictEqual(providers, {});
console.log('  ok   annotation listeners and providers are disposed with the extension');

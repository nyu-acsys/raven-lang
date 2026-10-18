'use strict';

/*
 * Checks for hovers and definitions from the names Raven reports (server/src/symbols.ts):
 * looking them up, and mapping positions across edits made since the check.
 */

const assert = require('assert');
const { hoverAt, definitionAt, outlineOf, inlayHintsOf, counterexampleValue, counterexampleValues } = require('../server/out/symbols');

const uri = 'file:///tests/main.rav';
const range = (line, start, end) => ({ start: { line, character: start }, end: { line, character: end } });
const checked = ['proc p(x: Int) {', '  var y := x;', '}'];
const table = {
	version: 1,
	lines: checked,
	references: [{ range: range(1, 12, 13), symbol: 0 }],
	symbols: [{ name: 'x', kind: 'variable', detail: 'x: Int', location: { uri, range: range(0, 7, 8) } }]
};
const text = lines => lines.join('\n');

console.log('symbols');
const hover = hoverAt(table, text(checked), { line: 1, character: 12 });
assert.strictEqual(hover.contents.value, '```raven\nx: Int\n```');
assert.deepStrictEqual(hover.range, range(1, 12, 13));
assert.strictEqual(hoverAt(table, text(checked), { line: 1, character: 13 }).contents.kind, 'markdown');
assert.strictEqual(hoverAt(table, text(checked), { line: 1, character: 5 }), undefined);
assert.strictEqual(hoverAt(table, text(checked), { line: 0, character: 7 }), undefined);
assert.deepStrictEqual(definitionAt(table, uri, text(checked), { line: 1, character: 12 }),
	{ uri, range: range(0, 7, 8) });
console.log('  ok   hovers and definitions come from the use of a name at a position');

const inserted = ['// comment', ...checked];
assert.deepStrictEqual(hoverAt(table, text(inserted), { line: 2, character: 12 }).range, range(2, 12, 13));
assert.deepStrictEqual(definitionAt(table, uri, text(inserted), { line: 2, character: 12 }),
	{ uri, range: range(1, 7, 8) });
const edited = ['proc p(x: Int) {', '  var y := x + 1;', '}'];
assert.strictEqual(hoverAt(table, text(edited), { line: 1, character: 12 }), undefined);
const below = [...checked, '', 'proc q() {}'];
assert.ok(hoverAt(table, text(below), { line: 1, character: 12 }));
assert.strictEqual(hoverAt(table, text(below), { line: 4, character: 5 }), undefined);
console.log('  ok   unchanged lines keep their hovers after edits; changed ones have none');

const elsewhere = { ...table, symbols: [{ ...table.symbols[0], location: { uri: 'file:///lib.rav', range: range(5, 0, 3) } }] };
assert.deepStrictEqual(definitionAt(elsewhere, uri, text(inserted), { line: 2, character: 12 }),
	{ uri: 'file:///lib.rav', range: range(5, 0, 3) });
const noDetail = { ...table, symbols: [{ ...table.symbols[0], detail: undefined }] };
assert.strictEqual(hoverAt(noDetail, text(checked), { line: 1, character: 12 }).contents.value, '`x`');
const qualified = { ...table, symbols: [{ ...table.symbols[0], name: 'M.f', detail: 'func f()' }] };
assert.strictEqual(hoverAt(qualified, text(checked), { line: 1, character: 12 }).contents.value,
	'```raven\nfunc f()\n```\n\n`M.f`');
console.log('  ok   definitions in other files are not shifted; hovers show the qualified name only if it has modules or there is no declaration');

const source = ['module M {', '  proc p() {', '    assert a: true;', '  }', '}', 'func f() returns (r: Int)'];
const entry = (name, kind, line, start, end, endLine, endChar, status) =>
	({ name, kind, status, selection: range(line, start, end), range: { start: { line, character: start }, end: { line: endLine, character: endChar } } });
const outline = {
	version: 1,
	lines: source,
	entries: [
		entry('M.p.a', 'assertion', 2, 4, 19, 2, 19, 'verified'),
		entry('M.p', 'proc', 1, 7, 8, 3, 3, 'failed'),
		entry('f', 'func', 5, 5, 6, 5, 25),
		entry('M', 'module', 0, 7, 8, 4, 1)
	]
};
const tree = outlineOf(outline, text(source));
assert.deepStrictEqual(tree.map(s => s.name), ['M', 'f']);
assert.deepStrictEqual(tree[0].children.map(s => [s.name, s.detail]), [['p', '✗ failed']]);
assert.deepStrictEqual(tree[0].children[0].children.map(s => [s.name, s.detail]), [['a', '✓ verified']]);
assert.strictEqual(tree[1].detail, 'func');
console.log('  ok   the outline nests members under modules and named assertions under members');

const insertedInBody = ['module M {', '  proc p() {', '    assert a: true;', '    assert b: true;', '  }', '}', 'func f() returns (r: Int)'];
const shifted = outlineOf(outline, text(insertedInBody));
assert.deepStrictEqual(shifted.map(s => [s.name, s.range.end.line]), [['M', 5], ['f', 6]]);
assert.deepStrictEqual(shifted[0].children.map(s => [s.name, s.range.end.line]), [['p', 4]]);
assert.deepStrictEqual(shifted[0].children[0].children.map(s => s.name), ['a']);
const changed = ['module M {', '  proc p() {', '    assert a: false;', '  }', '}', 'func f() returns (r: Int)'];
assert.deepStrictEqual(outlineOf(outline, text(changed))[0].children[0].children, []);
console.log('  ok   after edits, outline entries shift, and those on changed lines are left out');

const failing = ['proc p(x: Int, r: Ref) {', '  var y := x * 2;', '  assert y > r.f;', '}'];
const counterexamples = {
	version: 1,
	lines: failing,
	entries: [{
		range: range(2, 9, 16), certain: false,
		values: counterexampleValues(['x = 3', 'y = 6', 'r = ref#1', 'r.f = 7 (permission 1)', 'not a value'])
	}]
};
assert.deepStrictEqual(counterexamples.entries[0].values.map(v => v.name), ['x', 'y', 'r', 'r.f']);
const [hint] = inlayHintsOf(counterexamples, text(failing));
assert.deepStrictEqual(hint.position, { line: 2, character: 16 });
assert.strictEqual(hint.label, 'possibly y = 6, r.f = 7 (permission 1)');
assert(hint.tooltip.value.startsWith('**Possible counterexample**'));
assert(hint.tooltip.value.endsWith('```\nx = 3\ny = 6\nr = ref#1\nr.f = 7 (permission 1)\n```'));
assert.deepStrictEqual(inlayHintsOf(counterexamples, text(['// new', ...failing])).map(h => h.position.line), [3]);
assert.deepStrictEqual(inlayHintsOf(counterexamples, text(['proc p(x: Int, r: Ref) {', '  var y := x * 2;', '  assert y >= r.f;', '}'])), []);
const unmentioned = { ...counterexamples, entries: [{ ...counterexamples.entries[0], range: range(3, 0, 1), certain: true }] };
assert.strictEqual(inlayHintsOf(unmentioned, text(failing))[0].label, 'x = 3, y = 6, r = ref#1, r.f = 7 (permission 1)');
console.log('  ok   inlay hints show the values a failure mentions, or all, on unchanged lines');

const procOutline = { version: 1, lines: failing, entries: [entry('p', 'proc', 0, 5, 6, 3, 1)] };
assert.deepStrictEqual(counterexampleValue(counterexamples, procOutline, text(failing), { line: 1, character: 7 }, 'y'),
	{ line: 2, value: '6', certain: false });
assert.strictEqual(counterexampleValue(counterexamples, procOutline, text(failing), { line: 1, character: 7 }, 'z'), undefined);
assert.strictEqual(counterexampleValue(counterexamples, undefined, text(failing), { line: 1, character: 7 }, 'y'), undefined);
console.log('  ok   a variable of a failing callable has its value at the failure');

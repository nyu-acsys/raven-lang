'use strict';

/*
 * Checks for hovers and definitions from the names Raven reports (server/src/symbols.ts):
 * looking them up, and mapping positions across edits made since the check.
 */

const assert = require('assert');
const { hoverAt, definitionAt } = require('../server/out/symbols');

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

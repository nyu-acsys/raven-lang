/* --------------------------------------------------------------------------------------------
 * The names a document uses and what they refer to, as Raven reports them (protocol 4),
 * for hovers and going to definitions. A table belongs to the version of the document
 * Raven checked; for a later version, a position on a line the edits since did not touch
 * is mapped to that version, and other positions have no answer until the next check.
 * ------------------------------------------------------------------------------------------ */

import { SymbolKind } from 'vscode-languageserver/node';
import type { DocumentSymbol, Hover, InlayHint, Location, Position, Range } from 'vscode-languageserver/node';

export interface SymbolInfo { name: string, kind: string, detail?: string, location: Location }

/** A use of a name: its range in the checked version, and what it refers to. */
export interface SymbolReference { range: Range, symbol: number }

export interface SymbolTable {
	version: number,
	lines: string[],
	references: SymbolReference[],
	symbols: SymbolInfo[]
}

/**
 * How lines of the checked version [old] and of the current one [current] correspond:
 * the number of lines at the start and at the end that are unchanged.
 */
function unchangedLines(old: string[], current: string[]): { prefix: number, suffix: number } {
	let prefix = 0;
	while (prefix < old.length && prefix < current.length && old[prefix] === current[prefix]) prefix++;
	let suffix = 0;
	while (suffix < old.length - prefix && suffix < current.length - prefix
		&& old[old.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix++;
	return { prefix, suffix };
}

/** The line of [current] that each line of the checked version [old] is, if unchanged. */
function lineMap(old: string[], current: string[]): (line: number) => number | undefined {
	const { prefix, suffix } = unchangedLines(old, current);
	return line => line < prefix ? line
		: line >= old.length - suffix ? line + (current.length - old.length) : undefined;
}

/** The line of the checked version that [line] of [current] is, if unchanged. */
function toCheckedLine(table: { lines: string[] }, current: string[], line: number): number | undefined {
	const { prefix, suffix } = unchangedLines(table.lines, current);
	if (line < prefix) return line;
	if (line >= current.length - suffix) return line - (current.length - table.lines.length);
	return undefined;
}

/** The line of [current] that [line] of the checked version is, if unchanged. */
function toCurrentLine(table: SymbolTable, current: string[], line: number): number | undefined {
	const { prefix, suffix } = unchangedLines(table.lines, current);
	if (line < prefix) return line;
	if (line >= table.lines.length - suffix) return line + (current.length - table.lines.length);
	return undefined;
}

/** The use of a name at [position] of the current version of the document, [text]. */
function referenceAt(table: SymbolTable, text: string, position: Position) {
	const current = text.split('\n');
	const line = toCheckedLine(table, current, position.line);
	if (line === undefined) return undefined;
	const reference = table.references.find(r => r.range.start.line === line
		&& r.range.start.character <= position.character && position.character <= r.range.end.character);
	if (!reference) return undefined;
	const range = {
		start: { line: position.line, character: reference.range.start.character },
		end: { line: position.line, character: reference.range.end.character }
	};
	return { range, symbol: table.symbols[reference.symbol], current };
}

/** What the name at [position] of the current version of the document, [text], refers to. */
export function symbolAt(table: SymbolTable, text: string, position: Position): SymbolInfo | undefined {
	return referenceAt(table, text, position)?.symbol;
}

export function hoverAt(table: SymbolTable, text: string, position: Position): Hover | undefined {
	const found = referenceAt(table, text, position);
	if (!found?.symbol) return undefined;
	const { symbol, range } = found;
	// The declaration names the symbol without its modules; the qualified name adds them.
	const parts = [
		...(symbol.detail ? ['```raven\n' + symbol.detail + '\n```'] : []),
		...(symbol.name.includes('.') || !symbol.detail ? [`\`${symbol.name}\``] : [])
	];
	return { contents: { kind: 'markdown', value: parts.join('\n\n') }, range };
}

/** The declaration of the name at [position], in the document [uri] if it is there. */
export function definitionAt(table: SymbolTable, uri: string, text: string, position: Position): Location | undefined {
	const found = referenceAt(table, text, position);
	if (!found?.symbol) return undefined;
	const { location } = found.symbol;
	if (location.uri !== uri) return location;
	const start = toCurrentLine(table, found.current, location.range.start.line);
	const end = toCurrentLine(table, found.current, location.range.end.line);
	if (start === undefined || end === undefined) return location;
	return {
		uri,
		range: {
			start: { line: start, character: location.range.start.character },
			end: { line: end, character: location.range.end.character }
		}
	};
}

/** A member, module or named assertion as the outline shows it (protocol 4). */
export interface OutlineEntry {
	name: string,
	kind: string,
	status?: string,
	/** Its name, and its whole text, in the checked version. */
	selection: Range,
	range: Range
}

export interface Outline { version: number, lines: string[], entries: OutlineEntry[] }

const OUTLINE_KINDS: Record<string, SymbolKind> = {
	module: SymbolKind.Module, interface: SymbolKind.Interface, instance: SymbolKind.Module,
	proc: SymbolKind.Method, lemma: SymbolKind.Method, axiom: SymbolKind.Method,
	func: SymbolKind.Function, pred: SymbolKind.Function, inv: SymbolKind.Function,
	field: SymbolKind.Field, type: SymbolKind.Struct, val: SymbolKind.Constant,
	assertion: SymbolKind.Property, invariant: SymbolKind.Property
};

const STATUS_DETAILS: Record<string, string> = {
	verified: '✓ verified', failed: '✗ failed', timeout: '⏱ timed out', skipped: '– skipped'
};

/**
 * The outline of the current version of the document, [text]: each entry under the one
 * whose qualified name its own extends. An entry whose name is on a line changed since
 * the check is left out, and one whose end is on such a line ends at the last of them.
 */
export function outlineOf(outline: Outline, text: string): DocumentSymbol[] {
	const current = text.split('\n');
	const { prefix, suffix } = unchangedLines(outline.lines, current);
	const changedEnd = Math.max(prefix, current.length - suffix - 1);
	const map = lineMap(outline.lines, current);
	const symbols = new Map<string, DocumentSymbol>();
	const roots: DocumentSymbol[] = [];
	for (const entry of outline.entries) {
		const start = map(entry.selection.start.line);
		const rangeStart = map(entry.range.start.line);
		if (start === undefined || rangeStart === undefined) continue;
		const at = (line: number, character: number) => ({ line, character });
		const symbol: DocumentSymbol = {
			name: entry.name.slice(entry.name.lastIndexOf('.') + 1),
			detail: (entry.status && STATUS_DETAILS[entry.status]) ?? entry.kind,
			kind: OUTLINE_KINDS[entry.kind] ?? SymbolKind.Object,
			selectionRange: {
				start: at(start, entry.selection.start.character),
				end: at(start + entry.selection.end.line - entry.selection.start.line, entry.selection.end.character)
			},
			range: {
				start: at(rangeStart, entry.range.start.character),
				end: at(map(entry.range.end.line) ?? changedEnd, entry.range.end.character)
			},
			children: []
		};
		symbols.set(entry.name, symbol);
	}
	// Parents first: a name is longer than any it extends.
	for (const name of [...symbols.keys()].sort((a, b) => a.length - b.length)) {
		const symbol = symbols.get(name)!;
		let parent: DocumentSymbol | undefined;
		for (let i = name.lastIndexOf('.'); i > 0 && !parent; i = name.lastIndexOf('.', i - 1)) {
			parent = symbols.get(name.slice(0, i));
		}
		(parent ? parent.children! : roots).push(symbol);
	}
	const byPosition = (a: DocumentSymbol, b: DocumentSymbol) =>
		a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character;
	const sort = (list: DocumentSymbol[]) => { list.sort(byPosition); list.forEach(s => sort(s.children!)); };
	sort(roots);
	return roots;
}

/** The values of a counterexample to the failure at [range], in the checked version. */
export interface CounterexampleEntry {
	range: Range,
	certain: boolean,
	values: { name: string, value: string }[]
}

export interface Counterexamples { version: number, lines: string[], entries: CounterexampleEntry[] }

/** The values Raven reports for an entry of kind Counterexample, one `name = value` a line. */
export function counterexampleValues(message: string[]): { name: string, value: string }[] {
	return message.flatMap(line => {
		const at = line.indexOf(' = ');
		return at > 0 ? [{ name: line.slice(0, at), value: line.slice(at + 3) }] : [];
	});
}

/** The variables and fields such as `r.f` that [text] mentions. */
function mentioned(text: string): Set<string> {
	return new Set(text.match(/[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)?/g) ?? []);
}

/**
 * Inlay hints at the end of each failure on a line unchanged since the check, with the
 * values of what it mentions, or of all variables if it mentions none of them, and the
 * whole counterexample in its tooltip. The editor shortens long hints
 * (`editor.inlayHints.maximumLength`).
 */
export function inlayHintsOf(counterexamples: Counterexamples, text: string): InlayHint[] {
	const current = text.split('\n');
	const map = lineMap(counterexamples.lines, current);
	return counterexamples.entries.flatMap(entry => {
		const start = map(entry.range.start.line);
		const end = map(entry.range.end.line);
		if (start === undefined || end === undefined) return [];
		const failing = current.slice(start, end + 1).join('\n');
		const names = mentioned(failing);
		const shown = entry.values.filter(v => names.has(v.name));
		const label = (shown.length > 0 ? shown : entry.values).map(v => `${v.name} = ${v.value}`).join(', ');
		const note = entry.certain
			? '**Counterexample**: values for which the check fails.'
			: '**Possible counterexample**: the solver could not decide the check, so these values may contradict quantified facts.';
		return [{
			position: { line: end, character: entry.range.end.character },
			label: entry.certain ? label : `possibly ${label}`,
			paddingLeft: true,
			tooltip: {
				kind: 'markdown',
				value: `${note}\n\n\`\`\`\n${entry.values.map(v => `${v.name} = ${v.value}`).join('\n')}\n\`\`\``
			}
		}];
	});
}

/**
 * The name a counterexample gives the value of [symbol], used at [start] of [line]: a
 * variable's own, and for a field of a variable, as in `r.f`, the variable's and the
 * field's.
 */
export function valueName(symbol: SymbolInfo, line: string, start: number): string | undefined {
	if (symbol.kind === 'variable') return symbol.name;
	if (symbol.kind !== 'field' || line[start - 1] !== '.') return undefined;
	const receiver = /[A-Za-z_][A-Za-z0-9_']*$/.exec(line.slice(0, start - 1));
	if (!receiver || (receiver.index > 0 && line[receiver.index - 1] === '.')) return undefined;
	return `${receiver[0]}.${symbol.name.slice(symbol.name.lastIndexOf('.') + 1)}`;
}

const CALLABLE_KINDS = new Set(['proc', 'lemma', 'func', 'pred', 'inv']);

/**
 * The value of the variable [name] at a failure in the callable that [position] of the
 * current version, [text], is in, from the counterexamples and the [outline] of the check.
 */
export function counterexampleValue(counterexamples: Counterexamples, outline: Outline | undefined,
	text: string, position: Position, name: string): { line: number, value: string, certain: boolean } | undefined {
	const current = text.split('\n');
	const line = toCheckedLine(counterexamples, current, position.line);
	if (line === undefined) return undefined;
	const within = (range: Range, l: number) => range.start.line <= l && l <= range.end.line;
	const callables = (outline?.entries ?? []).filter(e => CALLABLE_KINDS.has(e.kind));
	const callable = callables.filter(e => within(e.range, line))
		.sort((a, b) => (a.range.end.line - a.range.start.line) - (b.range.end.line - b.range.start.line))[0];
	if (!callable) return undefined;
	for (const entry of counterexamples.entries) {
		if (!within(callable.range, entry.range.start.line)) continue;
		const value = entry.values.find(v => v.name === name);
		const failure = lineMap(counterexamples.lines, current)(entry.range.start.line);
		if (value && failure !== undefined) return { line: failure, value: value.value, certain: entry.certain };
	}
	return undefined;
}

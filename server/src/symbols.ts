/* --------------------------------------------------------------------------------------------
 * The names a document uses and what they refer to, as Raven reports them (protocol 4),
 * for hovers and going to definitions. A table belongs to the version of the document
 * Raven checked; for a later version, a position on a line the edits since did not touch
 * is mapped to that version, and other positions have no answer until the next check.
 * ------------------------------------------------------------------------------------------ */

import type { Hover, Location, Position, Range } from 'vscode-languageserver/node';

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

/** The line of the checked version that [line] of [current] is, if unchanged. */
function toCheckedLine(table: SymbolTable, current: string[], line: number): number | undefined {
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

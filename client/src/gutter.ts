/* --------------------------------------------------------------------------------------------
 * Which lines get a gutter marker, and what hovering one says.
 *
 * Kept apart from the decoration plumbing in extension.ts because the rules here -- one
 * marker per line, a failure outranking the related location explaining it, several
 * diagnostics on a line collapsing into one hover -- are the part that can quietly go
 * wrong, and the part worth testing.
 * ------------------------------------------------------------------------------------------ */

import { Diagnostic, DiagnosticSeverity } from 'vscode';

/** Line number to the messages reported against it, in the order Raven reported them. */
export type LineMessages = Map<number, string[]>;

export interface GutterMarkers {
	/** Lines carrying a failure. */
	errors: LineMessages;
	/** Lines carrying only related locations; disjoint from {@link errors}. */
	related: LineMessages;
}

/**
 * Group Raven's diagnostics by the line each starts at.
 *
 * Only the starting line, deliberately: a diagnostic can span a whole procedure body, and
 * striping the gutter down its full length says nothing that one marker at the top does
 * not. And a line with a failure on it is marked as a failure even when a related
 * location shares it -- the related location is still underlined in the text and listed
 * under the diagnostic, so nothing is lost by letting the more serious marker win.
 */
export function gutterMarkers(diagnostics: readonly Diagnostic[]): GutterMarkers {
	const errors: LineMessages = new Map();
	const related: LineMessages = new Map();

	for (const diagnostic of diagnostics) {
		// Other extensions' diagnostics are none of our business.
		if (diagnostic.source !== 'raven') continue;

		// Only the two severities that mean something on a line of Raven source. The
		// warning the server reports when it cannot run the verifier at all is the other
		// one that reaches here, and it is pinned to line 1 rather than describing
		// anything there -- it has a squiggle and a Problems entry, and a gutter marker
		// on an arbitrary line would only mislead.
		let lines: LineMessages;
		if (diagnostic.severity === DiagnosticSeverity.Error) {
			lines = errors;
		} else if (diagnostic.severity === DiagnosticSeverity.Information) {
			lines = related;
		} else {
			continue;
		}

		const line = diagnostic.range.start.line;
		lines.set(line, [...(lines.get(line) ?? []), diagnostic.message]);
	}

	for (const line of errors.keys()) {
		related.delete(line);
	}
	return { errors, related };
}

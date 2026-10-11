import { Diagnostic, DiagnosticSeverity } from 'vscode';

/** Line number to messages in Raven's reporting order. */
export type LineMessages = Map<number, string[]>;

/** Each marked line occurs in exactly one map. */
export interface GutterMarkers {
	errors: LineMessages;
	warnings: LineMessages;
	related: LineMessages;
}

/** One marker per starting line, with the most severe source diagnostic winning. */
export function gutterMarkers(diagnostics: readonly Diagnostic[]): GutterMarkers {
	const lines = new Map<number, { severity: DiagnosticSeverity, messages: string[] }>();
	for (const diagnostic of diagnostics) {
		if (diagnostic.source !== 'raven') continue;
		const severity = diagnostic.severity;
		// Launch warnings describe the whole run; strict warnings have source locations.
		if (severity !== DiagnosticSeverity.Error && severity !== DiagnosticSeverity.Information
			&& !(severity === DiagnosticSeverity.Warning && diagnostic.code === 'strict')) continue;

		const line = diagnostic.range.start.line;
		const entry = lines.get(line);
		if (entry) {
			if (severity < entry.severity) entry.severity = severity;
			entry.messages.push(diagnostic.message);
		} else {
			lines.set(line, { severity, messages: [diagnostic.message] });
		}
	}

	const errors: LineMessages = new Map();
	const warnings: LineMessages = new Map();
	const related: LineMessages = new Map();
	for (const [line, { severity, messages }] of lines) {
		const markers = severity === DiagnosticSeverity.Error ? errors
			: severity === DiagnosticSeverity.Warning ? warnings : related;
		markers.set(line, messages);
	}
	return { errors, warnings, related };
}

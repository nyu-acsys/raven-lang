import { Diagnostic, DiagnosticSeverity } from 'vscode';

export function verificationStatus(diagnostics: readonly Diagnostic[]): 'failed' | 'warnings' | 'succeeded' {
	if (diagnostics.some(d => d.severity === DiagnosticSeverity.Error)) return 'failed';
	if (diagnostics.some(d => d.source === 'raven' && d.severity === DiagnosticSeverity.Warning && d.code === 'strict')) return 'warnings';
	return 'succeeded';
}

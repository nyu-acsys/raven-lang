/* --------------------------------------------------------------------------------------------
 * Shows the contracts that members inherit from the interfaces they implement, as the
 * server reports them in the 'raven/inheritedContracts' notification: a code lens above
 * each such member shows its contract on one line and opens the interface's member, which
 * its tooltip names, and hovering over the member's name shows the contract in full.
 * Hovering over the name of a module shows the members it inherits rather than declaring
 * them itself, with headers and contracts but not bodies. The same notification carries
 * the verification status of each member, which a code lens above it shows; above a
 * module, it counts the statuses of the members nested in it.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import { State } from 'vscode-languageclient';
import type { VerificationUpdate } from './verificationStatus';

interface Location { uri: string, range: vscode.Range }

interface InheritedContract {
	range: vscode.Range,
	source: string,
	sourceLocation: Location,
	clauses: { keyword: string, text: string, location: Location, failing: boolean }[]
}

interface InheritedMembers {
	range: vscode.Range,
	members: { origin: string, text: string, location: Location }[]
}

interface MemberStatus {
	range: vscode.Range,
	name: string,
	kind: string,
	status: string,
	/** For a module or interface: how many of its members have each status. */
	counts?: Record<string, number>,
	/** Whether a module inherits it; it is then located at the module. */
	inherited?: boolean
}

interface InheritedAnnotations {
	uri: string,
	version: number,
	runId: number,
	contracts: InheritedContract[],
	modules?: InheritedMembers[],
	members?: MemberStatus[]
}

/** The title and tooltip of the code lens for each status. */
const STATUS_LENSES: Record<string, { title: string, tooltip: string }> = {
	verified: { title: '✓ verified', tooltip: 'Raven verified this {kind}.' },
	failed: { title: '✗ failed', tooltip: 'Raven could not verify this {kind}; see its errors.' },
	timeout: { title: '⏱ timed out', tooltip: 'The solver timed out on this {kind}; ravenServer.smtTimeout sets its time limit.' },
	skipped: { title: '– skipped', tooltip: 'Raven stopped before checking this {kind}, after reaching the error limit.' }
};

/** The kinds of members that can be verified on their own. */
const VERIFIABLE = new Set(['proc', 'lemma', 'func', 'pred', 'inv', 'module', 'interface', 'assertion']);

/**
 * The code lens that verifies only [member] from now on, or, if it is the [focus], all of
 * the document again.
 */
function verifyLens(uri: string, member: MemberStatus, focus: string | undefined): vscode.CodeLens {
	const range = toRange(member.range);
	return member.name === focus
		? new vscode.CodeLens(range, {
			title: 'Verify all',
			tooltip: `Raven verifies only ${member.name}. Click to verify the whole file again.`,
			command: 'raven.verifyAll',
			arguments: [uri]
		})
		: new vscode.CodeLens(range, {
			title: 'Verify this',
			tooltip: `Verify only ${member.name}, now and after each edit, until "Verify all".`,
			command: 'raven.verifyThis',
			arguments: [uri, member.name]
		});
}

/** The words for each status in a module's summary, worst first. */
const SUMMARY_WORDS: [string, string][] = [
	['failed', 'failed'], ['timeout', 'timed out'], ['skipped', 'skipped'], ['verified', 'verified']
];

/**
 * The code lens showing the status of [member], if it has a known status. A module's lists
 * the members it inherits from [members], which have no code lens of their own.
 */
function statusLens(member: MemberStatus, members: MemberStatus[]): vscode.CodeLens | undefined {
	const lens = STATUS_LENSES[member.status];
	if (!lens || member.inherited) return undefined;
	if (member.counts) {
		const counts = member.counts;
		const parts = SUMMARY_WORDS.filter(([status]) => counts[status] > 0)
			.map(([status, words]) => `${counts[status]} ${words}`);
		const inherited = members
			.filter(m => m.inherited && m.name.startsWith(`${member.name}.`))
			.map(m => `\n${STATUS_LENSES[m.status]?.title ?? m.status}: ${m.kind} ${m.name.slice(member.name.length + 1)}`);
		return new vscode.CodeLens(toRange(member.range), {
			title: `${lens.title.split(' ')[0]} ${parts.join(', ')}`,
			tooltip: `The verification status of the members of ${member.kind} ${member.name}.`
				+ (inherited.length > 0 ? `\nInherited:${inherited.join('')}` : ''),
			command: ''
		});
	}
	return new vscode.CodeLens(toRange(member.range), {
		title: lens.title,
		tooltip: `${member.name}: ${lens.tooltip.replace('{kind}', member.kind)}`,
		command: ''
	});
}

/** How many characters of the contract a code lens shows before shortening it. */
const LENS_LENGTH = 120;

function toRange(range: vscode.Range): vscode.Range {
	return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

/** A link that opens [location] in the editor. */
function linkTo(location: Location): string {
	const args = [vscode.Uri.parse(location.uri), { selection: toRange(location.range) }];
	return `command:vscode.open?${encodeURIComponent(JSON.stringify(args))}`;
}

/** The contract on one line, shortened to [LENS_LENGTH] characters. */
function summary(contract: InheritedContract): string {
	const text = contract.clauses
		.map(c => `${c.failing ? '✗ ' : ''}${c.keyword} ${c.text.replace(/\s+/g, ' ')}`)
		.join(' · ');
	return text.length > LENS_LENGTH ? text.slice(0, LENS_LENGTH - 1) + '…' : text;
}

/** The contract as it would be written below the member's header. */
function hoverText(contract: InheritedContract): vscode.MarkdownString {
	const lines = contract.clauses.map(c => {
		const text = c.text.split('\n').map(l => l.trim()).join('\n    ');
		return `  ${c.keyword} ${text}${c.failing ? '  // ✗ may not hold' : ''}`;
	});
	const markdown = new vscode.MarkdownString(
		`Contract inherited from [${contract.source}](${linkTo(contract.sourceLocation)})\n\n` +
		'```raven\n' + lines.join('\n') + '\n```');
	markdown.isTrusted = { enabledCommands: ['vscode.open'] };
	return markdown;
}

/** The members a module inherits, grouped by the interface they originate from. */
function membersHoverText(module: InheritedMembers): vscode.MarkdownString {
	const groups = new Map<string, InheritedMembers['members']>();
	for (const member of module.members) {
		groups.set(member.origin, [...(groups.get(member.origin) ?? []), member]);
	}
	const sections = [...groups.entries()].map(([origin, members]) =>
		`Inherited from [${origin}](${linkTo(members[0].location)})\n\n` +
		'```raven\n' + members.map(m => m.text).join('\n\n') + '\n```');
	const markdown = new vscode.MarkdownString(sections.join('\n\n'));
	markdown.isTrusted = { enabledCommands: ['vscode.open'] };
	return markdown;
}

export function registerInheritedContracts(context: vscode.ExtensionContext, client: LanguageClient) {
	const annotations = new Map<string, InheritedAnnotations>();
	const runs = new Map<string, { version: number, runId: number, accepting: boolean }>();
	// The focus of each document's checks, as the server last reported it.
	const focuses = new Map<string, string>();
	const lensesChanged = new vscode.EventEmitter<void>();
	const openDocument = (uri: string) => vscode.workspace.textDocuments.find(d => d.uri.toString() === uri);
	const currentAnnotations = (document: vscode.TextDocument) => {
		const entry = annotations.get(document.uri.toString());
		return entry?.version === document.version ? entry : undefined;
	};
	const invalidate = (uri: string) => {
		const run = runs.get(uri);
		if (run) run.accepting = false;
		if (annotations.delete(uri)) lensesChanged.fire();
	};
	const clear = () => {
		runs.clear();
		focuses.clear();
		const hadAnnotations = annotations.size > 0;
		annotations.clear();
		if (hadAnnotations) lensesChanged.fire();
	};
	const onVerificationState = (update: VerificationUpdate) => {
		if (openDocument(update.uri)?.version === update.version && focuses.get(update.uri) !== update.focus) {
			if (update.focus) focuses.set(update.uri, update.focus);
			else focuses.delete(update.uri);
			lensesChanged.fire();
		}
		if (update.state !== 'running' || openDocument(update.uri)?.version !== update.version) return;
		if ((runs.get(update.uri)?.runId ?? -1) >= update.runId) return;
		invalidate(update.uri);
		runs.set(update.uri, { version: update.version, runId: update.runId, accepting: true });
	};
	const onVerificationInvalidated = (update: { uri: string, version: number, runId: number }) => {
		if (openDocument(update.uri)?.version !== update.version) return;
		if ((runs.get(update.uri)?.runId ?? -1) <= update.runId) invalidate(update.uri);
	};
	context.subscriptions.push(lensesChanged, { dispose: clear },
		vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
			if (contentChanges.length > 0) invalidate(document.uri.toString());
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			invalidate(document.uri.toString());
			runs.delete(document.uri.toString());
			focuses.delete(document.uri.toString());
		}),
		client.onDidChangeState(({ newState }) => {
			if (newState === State.Starting || newState === State.Stopped) clear();
		}),
		client.onNotification('raven/inheritedContracts', (params: InheritedAnnotations) => {
			const document = openDocument(params.uri);
			const run = runs.get(params.uri);
			if (!document || !run?.accepting || document.version !== params.version
				|| run.version !== params.version || run.runId !== params.runId) return;
			annotations.set(params.uri, params);
			lensesChanged.fire();
		}));

	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'raven' }, {
		onDidChangeCodeLenses: lensesChanged.event,
		provideCodeLenses(document) {
			const current = currentAnnotations(document);
			const members = current?.members ?? [];
			const statuses = members.map(member => statusLens(member, members))
				.filter((lens): lens is vscode.CodeLens => lens !== undefined);
			const focus = focuses.get(document.uri.toString());
			const verify = members.filter(m => VERIFIABLE.has(m.kind) && !m.inherited)
				.map(m => verifyLens(document.uri.toString(), m, focus));
			return statuses.concat(verify, (current?.contracts ?? []).map(contract =>
				new vscode.CodeLens(toRange(contract.range), {
					title: `inherited: ${summary(contract)}`,
					tooltip: `Contract inherited from ${contract.source}. Click to open it.`,
					command: 'vscode.open',
					arguments: [
						vscode.Uri.parse(contract.sourceLocation.uri),
						{ selection: toRange(contract.sourceLocation.range) }
					]
				})));
		}
	}));

	context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'raven' }, {
		provideHover(document, position) {
			const current = currentAnnotations(document);
			const contract = (current?.contracts ?? []).find(c => toRange(c.range).contains(position));
			if (contract) {
				return new vscode.Hover(hoverText(contract), toRange(contract.range));
			}
			const module = (current?.modules ?? []).find(m => toRange(m.range).contains(position));
			return module ? new vscode.Hover(membersHoverText(module), toRange(module.range)) : undefined;
		}
	}));
	return { onVerificationState, onVerificationInvalidated };
}

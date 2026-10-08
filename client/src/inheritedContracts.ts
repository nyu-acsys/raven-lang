/* --------------------------------------------------------------------------------------------
 * Shows the contracts that members inherit from the interfaces they implement, as the
 * server reports them in the 'raven/inheritedContracts' notification: a code lens above
 * each such member shows its contract on one line and opens the interface's member, which
 * its tooltip names, and hovering over the member's name shows the contract in full.
 * Hovering over the name of a module shows the members it inherits rather than declaring
 * them itself, with headers and contracts but not bodies.
 * ------------------------------------------------------------------------------------------ */

import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

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
	const contracts = new Map<string, InheritedContract[]>();
	const modules = new Map<string, InheritedMembers[]>();
	const lensesChanged = new vscode.EventEmitter<void>();
	context.subscriptions.push(lensesChanged);

	client.onNotification('raven/inheritedContracts', (params: { uri: string, contracts: InheritedContract[], modules?: InheritedMembers[] }) => {
		contracts.set(params.uri, params.contracts);
		modules.set(params.uri, params.modules ?? []);
		lensesChanged.fire();
	});

	context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'raven' }, {
		onDidChangeCodeLenses: lensesChanged.event,
		provideCodeLenses(document) {
			return (contracts.get(document.uri.toString()) ?? []).map(contract =>
				new vscode.CodeLens(toRange(contract.range), {
					title: `inherited: ${summary(contract)}`,
					tooltip: `Contract inherited from ${contract.source}. Click to open it.`,
					command: 'vscode.open',
					arguments: [
						vscode.Uri.parse(contract.sourceLocation.uri),
						{ selection: toRange(contract.sourceLocation.range) }
					]
				}));
		}
	}));

	context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'raven' }, {
		provideHover(document, position) {
			const uri = document.uri.toString();
			const contract = (contracts.get(uri) ?? []).find(c => toRange(c.range).contains(position));
			if (contract) {
				return new vscode.Hover(hoverText(contract), toRange(contract.range));
			}
			const module = (modules.get(uri) ?? []).find(m => toRange(m.range).contains(position));
			return module ? new vscode.Hover(membersHoverText(module), toRange(module.range)) : undefined;
		}
	}));
}

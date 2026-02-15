/**
 * Notebook definition search utilities for finding variable definitions.
 */
import * as vscode from 'vscode';
import { isSupportedNotebookLanguage } from './notebookUris';

export type DefinitionTarget = {
	document: vscode.TextDocument;
	range: vscode.Range;
};

/**
 * Escape special regex characters in a string.
 */
export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the definition location for a variable in a notebook.
 * First tries VS Code's definition provider, then falls back to assignment pattern matching.
 */
export async function findNotebookDefinitionLocation(
	notebook: vscode.NotebookDocument,
	variableName: string
): Promise<DefinitionTarget | undefined> {
	const escaped = escapeRegExp(variableName);
	const occurrence = findNotebookVariableOccurrence(notebook, escaped);
	if (occurrence) {
		const locations = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeDefinitionProvider',
			occurrence.document.uri,
			occurrence.range.start
		);
		if (locations && locations.length > 0) {
			const location = locations[0];
			const targetDoc = await vscode.workspace.openTextDocument(location.uri);
			return { document: targetDoc, range: location.range };
		}
	}
	return findNotebookAssignmentLocation(notebook, escaped);
}

/**
 * Find the first occurrence of a variable in a notebook.
 */
export function findNotebookVariableOccurrence(
	notebook: vscode.NotebookDocument,
	escapedName: string
): DefinitionTarget | undefined {
	const occurrenceRegex = new RegExp(`\\b${escapedName}\\b`);
	for (const cell of notebook.getCells()) {
		if (!isSupportedNotebookLanguage(cell.document.languageId)) {
			continue;
		}
		for (let lineIndex = 0; lineIndex < cell.document.lineCount; lineIndex += 1) {
			const line = cell.document.lineAt(lineIndex);
			const match = occurrenceRegex.exec(line.text);
			if (match?.index !== undefined) {
				const start = new vscode.Position(lineIndex, match.index);
				const end = new vscode.Position(lineIndex, match.index + match[0].length);
				return { document: cell.document, range: new vscode.Range(start, end) };
			}
		}
	}
	return;
}

/**
 * Find an assignment location for a variable in a notebook.
 */
export function findNotebookAssignmentLocation(
	notebook: vscode.NotebookDocument,
	escapedName: string
): DefinitionTarget | undefined {
	const assignmentRegex = new RegExp(`^(\\s*)(${escapedName})\\s*(=|:|\\+=|-=|\\*=|/=|//=|%=|\\*\\*=|>>=|<<=|&=|\\^=|\\|=)`);
	for (const cell of notebook.getCells()) {
		if (!isSupportedNotebookLanguage(cell.document.languageId)) {
			continue;
		}
		for (let lineIndex = 0; lineIndex < cell.document.lineCount; lineIndex += 1) {
			const line = cell.document.lineAt(lineIndex);
			const match = assignmentRegex.exec(line.text);
			if (match?.index !== undefined) {
				const leading = match[1]?.length ?? 0;
				const name = match[2] ?? '';
				const start = new vscode.Position(lineIndex, leading);
				const end = new vscode.Position(lineIndex, leading + name.length);
				return { document: cell.document, range: new vscode.Range(start, end) };
			}
		}
	}
	return;
}

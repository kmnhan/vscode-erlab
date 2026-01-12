/**
 * Notebook URI utilities for resolving notebook documents from cells.
 */
import * as vscode from 'vscode';

/**
 * Check if a document is a notebook cell document.
 */
export function isNotebookCellDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'vscode-notebook-cell';
}

/**
 * Get the notebook URI for a cell document.
 */
export function getNotebookUriForDocument(document: vscode.TextDocument): vscode.Uri | undefined {
	for (const notebook of vscode.workspace.notebookDocuments) {
		for (const cell of notebook.getCells()) {
			if (cell.document.uri.toString() === document.uri.toString()) {
				return notebook.uri;
			}
		}
	}
	return;
}

/**
 * Get the URI of the currently active notebook.
 */
export function getActiveNotebookUri(): vscode.Uri | undefined {
	const notebookEditor = vscode.window.activeNotebookEditor;
	if (notebookEditor?.notebook) {
		return notebookEditor.notebook.uri;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		return getNotebookUriForDocument(activeEditor.document);
	}
	return;
}

/**
 * Resolve a notebook URI from a serialized string, or fall back to the active notebook.
 */
export function resolveNotebookUri(serialized?: string): vscode.Uri | undefined {
	if (serialized) {
		try {
			return vscode.Uri.parse(serialized);
		} catch {
			// Fall back to active notebook.
		}
	}
	return getActiveNotebookUri();
}

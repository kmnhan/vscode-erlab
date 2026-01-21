/**
 * Notebook URI utilities for resolving notebook documents from cells.
 */
import * as vscode from 'vscode';
import * as path from 'path';

const notebookUriByCellDocument = new WeakMap<vscode.TextDocument, vscode.Uri>();
const notebookUriByCellString = new Map<string, vscode.Uri>();

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
	const cached = notebookUriByCellDocument.get(document);
	if (cached) {
		return cached;
	}
	for (const notebook of vscode.workspace.notebookDocuments) {
		for (const cell of notebook.getCells()) {
			if (cell.document.uri.toString() === document.uri.toString()) {
				notebookUriByCellDocument.set(document, notebook.uri);
				notebookUriByCellString.set(cell.document.uri.toString(), notebook.uri);
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
		const trimmed = serialized.trim();
		const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
		if (hasScheme) {
			try {
				const parsed = vscode.Uri.parse(trimmed);
				const direct = vscode.workspace.notebookDocuments.find(
					(doc) => doc.uri.toString() === parsed.toString()
				);
				if (direct) {
					return direct.uri;
				}
				if (parsed.scheme === 'vscode-notebook-cell') {
					const cached = notebookUriByCellString.get(parsed.toString());
					if (cached) {
						return cached;
					}
					for (const notebook of vscode.workspace.notebookDocuments) {
						const match = notebook
							.getCells()
							.some((cell) => cell.document.uri.toString() === parsed.toString());
						if (match) {
							return notebook.uri;
						}
					}
				}
				return parsed;
			} catch {
				// Fall back to file-path handling.
			}
		}
		if (path.isAbsolute(trimmed)) {
			const fileUri = vscode.Uri.file(trimmed);
			const direct = vscode.workspace.notebookDocuments.find(
				(doc) => doc.uri.fsPath === fileUri.fsPath
			);
			if (direct) {
				return direct.uri;
			}
			return fileUri;
		}
	}
	return getActiveNotebookUri();
}

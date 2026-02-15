/**
 * Notebook URI utilities for resolving notebook documents from cells.
 */
import * as vscode from 'vscode';
import * as path from 'path';

const notebookUriByCellDocument = new WeakMap<vscode.TextDocument, vscode.Uri>();
const notebookUriByCellString = new Map<string, vscode.Uri>();
const SUPPORTED_NOTEBOOK_TYPES = new Set(['jupyter-notebook', 'marimo-notebook']);
const SUPPORTED_NOTEBOOK_LANGUAGE_IDS = new Set(['python', 'mo-python']);

/**
 * Check if a document is a notebook cell document.
 */
export function isNotebookCellDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'vscode-notebook-cell';
}

/**
 * Check if a notebook type is supported by erlab features.
 */
export function isSupportedNotebookType(notebookType: string): boolean {
	return SUPPORTED_NOTEBOOK_TYPES.has(notebookType);
}

/**
 * Check if a language id is supported by erlab notebook features.
 */
export function isSupportedNotebookLanguage(languageId: string): boolean {
	return SUPPORTED_NOTEBOOK_LANGUAGE_IDS.has(languageId);
}

/**
 * Get the notebook document for a cell document.
 */
export function getNotebookDocumentForCellDocument(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
	if (!isNotebookCellDocument(document)) {
		return;
	}
	const notebookUri = getNotebookUriForDocument(document);
	if (!notebookUri) {
		return;
	}
	return vscode.workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === notebookUri.toString());
}

/**
 * Check if a document is a supported Python notebook cell document.
 */
export function isSupportedNotebookCellDocument(document: vscode.TextDocument): boolean {
	if (!isNotebookCellDocument(document) || !isSupportedNotebookLanguage(document.languageId)) {
		return false;
	}
	const notebook = getNotebookDocumentForCellDocument(document);
	if (!notebook) {
		return false;
	}
	return isSupportedNotebookType(notebook.notebookType);
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
	if (notebookEditor?.notebook && isSupportedNotebookType(notebookEditor.notebook.notebookType)) {
		return notebookEditor.notebook.uri;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const notebook = getNotebookDocumentForCellDocument(activeEditor.document);
		if (!notebook || !isSupportedNotebookType(notebook.notebookType)) {
			return;
		}
		return notebook.uri;
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

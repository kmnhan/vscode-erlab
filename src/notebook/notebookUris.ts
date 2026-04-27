/**
 * Notebook URI utilities for resolving notebook documents from cells.
 */
import * as vscode from 'vscode';
import * as path from 'path';

const notebookUriByCellDocument = new WeakMap<vscode.TextDocument, vscode.Uri>();
const notebookUriByCellString = new Map<string, vscode.Uri>();
const cellUrisByNotebook = new Map<string, Set<string>>();
const SUPPORTED_NOTEBOOK_TYPES = new Set(['jupyter-notebook', 'marimo-notebook']);
const SUPPORTED_NOTEBOOK_LANGUAGE_IDS = new Set(['python', 'mo-python']);

function getNotebookCacheKey(notebookUri: vscode.Uri): string {
	return notebookUri.toString();
}

function indexNotebookDocument(notebook: vscode.NotebookDocument): void {
	const notebookKey = getNotebookCacheKey(notebook.uri);
	const nextCellUris = new Set<string>();
	for (const cell of notebook.getCells()) {
		const cellKey = cell.document.uri.toString();
		nextCellUris.add(cellKey);
		notebookUriByCellDocument.set(cell.document, notebook.uri);
		notebookUriByCellString.set(cellKey, notebook.uri);
	}
	const previousCellUris = cellUrisByNotebook.get(notebookKey);
	if (previousCellUris) {
		for (const previousCellUri of previousCellUris) {
			if (!nextCellUris.has(previousCellUri)) {
				notebookUriByCellString.delete(previousCellUri);
			}
		}
	}
	cellUrisByNotebook.set(notebookKey, nextCellUris);
}

function unindexNotebookDocument(notebookUri: vscode.Uri): void {
	const notebookKey = getNotebookCacheKey(notebookUri);
	const cellUris = cellUrisByNotebook.get(notebookKey);
	if (cellUris) {
		for (const cellUri of cellUris) {
			notebookUriByCellString.delete(cellUri);
		}
	}
	cellUrisByNotebook.delete(notebookKey);
}

function seedNotebookDocumentIndex(): void {
	for (const notebook of vscode.workspace.notebookDocuments) {
		indexNotebookDocument(notebook);
	}
}

function resolveNotebookUriFromIndex(cellUri: string): vscode.Uri | undefined {
	return notebookUriByCellString.get(cellUri);
}

export function initializeNotebookUriIndex(): vscode.Disposable {
	seedNotebookDocumentIndex();
	const openDisposable = vscode.workspace.onDidOpenNotebookDocument((notebook) => {
		indexNotebookDocument(notebook);
	});
	const closeDisposable = vscode.workspace.onDidCloseNotebookDocument((notebook) => {
		unindexNotebookDocument(notebook.uri);
	});
	const changeDisposable = vscode.workspace.onDidChangeNotebookDocument((event) => {
		if (event.contentChanges.length > 0) {
			indexNotebookDocument(event.notebook);
		}
	});
	return vscode.Disposable.from(openDisposable, closeDisposable, changeDisposable);
}

/**
 * Check if a document is a notebook cell document.
 */
function isNotebookCellDocument(document: vscode.TextDocument): boolean {
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
	const indexed = resolveNotebookUriFromIndex(document.uri.toString());
	if (indexed) {
		notebookUriByCellDocument.set(document, indexed);
		return indexed;
	}
	for (const notebook of vscode.workspace.notebookDocuments) {
		indexNotebookDocument(notebook);
		const resolved = notebookUriByCellString.get(document.uri.toString());
		if (resolved) {
			notebookUriByCellDocument.set(document, resolved);
			return resolved;
		}
	}
	return;
}

/**
 * Get the URI of the currently active notebook.
 */
export function getActiveNotebookUri(): vscode.Uri | undefined {
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		const notebook = getNotebookDocumentForCellDocument(activeEditor.document);
		if (notebook && isSupportedNotebookType(notebook.notebookType)) {
			return notebook.uri;
		}
		return;
	}
	const notebookEditor = vscode.window.activeNotebookEditor;
	if (notebookEditor?.notebook && isSupportedNotebookType(notebookEditor.notebook.notebookType)) {
		return notebookEditor.notebook.uri;
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
						const cached = resolveNotebookUriFromIndex(parsed.toString());
						if (cached) {
							return cached;
						}
						for (const notebook of vscode.workspace.notebookDocuments) {
							indexNotebookDocument(notebook);
							const indexed = notebookUriByCellString.get(parsed.toString());
							if (indexed) {
								return indexed;
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

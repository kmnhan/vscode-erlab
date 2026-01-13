/**
 * DataArray hover provider for showing DataArray info on hover in notebook cells.
 */
import * as vscode from 'vscode';
import { isNotebookCellDocument, getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { encodeCommandArgs } from '../../commands';
import { getCachedDataArrayEntry } from '../dataArray/service';
import { formatDataArrayLabel } from '../dataArray/formatting';
import type { PinnedDataArrayStore } from '../dataArray/views/pinnedStore';

/**
 * Register the DataArray hover provider.
 */
export function registerDataArrayHoverProvider(
	pinnedStore: PinnedDataArrayStore
): vscode.Disposable {
	return vscode.languages.registerHoverProvider({ language: 'python' }, {
		provideHover: (document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined => {
			if (!isNotebookCellDocument(document)) {
				return;
			}

			const range = document.getWordRangeAtPosition(position);
			if (!range) {
				return;
			}

			const variableName = document.getText(range);
			if (!isValidPythonIdentifier(variableName)) {
				return;
			}

			// Use synchronous cache lookup - no kernel query on hover
			const notebookUri = getNotebookUriForDocument(document);
			if (!notebookUri) {
				return;
			}
			const info = getCachedDataArrayEntry(notebookUri, variableName);
			if (!info) {
				return;
			}

			const md = new vscode.MarkdownString();
			md.supportThemeIcons = true;
			const label = formatDataArrayLabel(info, variableName);
			md.appendMarkdown(`${label}\n\n`);
			const isPinned = pinnedStore.isPinned(notebookUri, variableName);
			const hoverArgs = encodeCommandArgs({
				variableName,
				ndim: info.ndim,
				notebookUri: notebookUri?.toString(),
			});
			if (info.watched) {
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.dataArray.openDetail?${hoverArgs}) | ` +
					`[$(eye) Show](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(eye-closed) Unwatch](command:erlab.unwatch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(empty-window) ImageTool](command:erlab.dataArray.openInImageTool?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.dataArray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n`
				);
			} else {
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.dataArray.openDetail?${hoverArgs}) | ` +
					`[$(eye) Watch](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(empty-window) ImageTool](command:erlab.dataArray.openInImageTool?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.dataArray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n`
				);
			}
			md.isTrusted = true;

			return new vscode.Hover(md, range);
		}
	});
}

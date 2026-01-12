/**
 * DataArray hover provider for showing DataArray info on hover in notebook cells.
 */
import * as vscode from 'vscode';
import { isNotebookCellDocument, getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { encodeCommandArgs } from '../../commands';
import { getDataArrayInfo } from '../dataArray/service';
import { formatDataArrayLabel } from '../dataArray/formatting';
import type { PinnedDataArrayStore } from '../dataArray/views/pinnedStore';

/**
 * Register the DataArray hover provider.
 */
export function registerDataArrayHoverProvider(
	pinnedStore: PinnedDataArrayStore
): vscode.Disposable {
	return vscode.languages.registerHoverProvider({ language: 'python' }, {
		provideHover: async (document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> => {
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
			const info = await getDataArrayInfo(document, variableName);
			if (!info) {
				return;
			}

			const md = new vscode.MarkdownString();
			md.supportThemeIcons = true;
			const label = formatDataArrayLabel(info, variableName);
			md.appendMarkdown(`${label}\n\n`);
			const notebookUri = getNotebookUriForDocument(document);
			const isPinned = notebookUri
				? pinnedStore.isPinned(notebookUri, variableName)
				: false;
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

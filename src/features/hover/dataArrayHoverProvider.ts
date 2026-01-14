/**
 * xarray hover provider for showing xarray object info on hover in notebook cells.
 */
import * as vscode from 'vscode';
import { isNotebookCellDocument, getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { encodeCommandArgs } from '../../commands';
import { getCachedXarrayEntry } from '../xarray/service';
import { formatXarrayLabel } from '../xarray/formatting';
import type { PinnedXarrayStore } from '../xarray/views/pinnedStore';

/**
 * Register the xarray hover provider.
 */
export function registerXarrayHoverProvider(
	pinnedStore: PinnedXarrayStore
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
			const info = getCachedXarrayEntry(notebookUri, variableName);
			if (!info) {
				return;
			}

			const md = new vscode.MarkdownString();
			md.supportThemeIcons = true;
			const label = formatXarrayLabel(info, variableName);
			md.appendMarkdown(`**${info.type}**: ${label}\n\n`);

			const isPinned = pinnedStore.isPinned(notebookUri, variableName);
			const hoverArgs = encodeCommandArgs({
				variableName,
				ndim: info.ndim,
				notebookUri: notebookUri?.toString(),
				type: info.type,
			});

			// DataArray: show all actions including watch and ImageTool
			if (info.type === 'DataArray') {
				if (info.watched) {
					md.appendMarkdown(
						`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
						`[$(eye) Show](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
						`[$(eye-closed) Unwatch](command:erlab.unwatch?${encodeCommandArgs({ variableName })}) | ` +
						`[$(empty-window) ImageTool](command:erlab.xarray.openInImageTool?${hoverArgs}) | ` +
						`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })}) | ` +
						`[$(ellipsis) More...](command:erlab.xarray.otherTools?${encodeCommandArgs({ variableName })})\n`
					);
				} else {
					md.appendMarkdown(
						`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
						`[$(eye) Watch](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
						`[$(empty-window) ImageTool](command:erlab.xarray.openInImageTool?${hoverArgs}) | ` +
						`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })}) | ` +
						`[$(ellipsis) More...](command:erlab.xarray.otherTools?${encodeCommandArgs({ variableName })})\n`
					);
				}
			} else {
				// Dataset and DataTree: only show Details and Pin
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n\n`
				);
			}
			md.isTrusted = true;

			return new vscode.Hover(md, range);
		}
	});
}

/**
 * @deprecated Use registerXarrayHoverProvider instead
 */
export const registerDataArrayHoverProvider = registerXarrayHoverProvider;

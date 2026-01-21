/**
 * xarray hover provider for showing xarray object info on hover in notebook cells.
 */
import * as vscode from 'vscode';
import { isNotebookCellDocument, getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { encodeCommandArgs } from '../../commands';
import {
	getCachedXarrayEntry,
	hasXarrayEntryDetails,
	isXarrayEntryStale,
	refreshXarrayEntry,
} from '../xarray/service';
import { formatXarrayLabel } from '../xarray/formatting';
import type { PinnedXarrayStore } from '../xarray/views/pinnedStore';

/**
 * Register the xarray hover provider.
 */
export function registerXarrayHoverProvider(
	pinnedStore: PinnedXarrayStore,
	options?: { isErlabAvailable?: (notebookUri: vscode.Uri) => boolean }
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

			// Use cache lookup first; only refresh known DataArrays on demand.
			const notebookUri = getNotebookUriForDocument(document);
			if (!notebookUri) {
				return;
			}
			let info = getCachedXarrayEntry(notebookUri, variableName);
			if (!info) {
				return;
			}
			const needsDetails = info.type === 'DataArray' && !hasXarrayEntryDetails(notebookUri, variableName);
			const isStale = info.type === 'DataArray' && isXarrayEntryStale(notebookUri, variableName);
			if (needsDetails || isStale) {
				const refreshed = await refreshXarrayEntry(notebookUri, variableName, {
					includeDetails: true,
					reason: 'hover',
				});
				if (refreshed.entry) {
					info = refreshed.entry;
				}
			}
			if (!info) {
				return;
			}

			const erlabAvailable = options?.isErlabAvailable?.(notebookUri) ?? true;
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

			// DataArray: show all actions including watch and ImageTool when ERLab is available.
			if (info.type === 'DataArray') {
				if (erlabAvailable) {
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
					md.appendMarkdown(
						`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
						`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n\n`
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

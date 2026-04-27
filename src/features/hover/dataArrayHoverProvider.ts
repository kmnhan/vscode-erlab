/**
 * xarray hover provider for showing xarray object info on hover in notebook cells.
 */
import * as vscode from 'vscode';
import { isSupportedNotebookCellDocument, getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { encodeCommandArgs } from '../../commands';
import {
	getCachedXarrayEntry,
	hasXarrayEntryDetails,
	isXarrayListStale,
	isXarrayEntryStale,
	shouldAutoRefreshXarrayList,
	refreshXarrayCache,
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
	return vscode.languages.registerHoverProvider([{ language: 'python' }, { language: 'mo-python' }], {
		provideHover: async (document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> => {
			if (!isSupportedNotebookCellDocument(document)) {
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

			// Namespace-level staleness invalidates cached hits, so refresh before showing actions.
			const notebookUri = getNotebookUriForDocument(document);
			if (!notebookUri) {
				return;
			}
			const listStale = isXarrayListStale(notebookUri);
			let info = listStale ? undefined : getCachedXarrayEntry(notebookUri, variableName);
			if (listStale && shouldAutoRefreshXarrayList(notebookUri)) {
				const refreshedEntries = await refreshXarrayCache(notebookUri);
				if (refreshedEntries.error) {
					return;
				}
				info = getCachedXarrayEntry(notebookUri, variableName);
			}
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
			const watchAvailable = info.type === 'DataArray' && info.watchAvailable !== false;
			const hoverArgs = encodeCommandArgs({
				variableName,
				ndim: info.ndim,
				notebookUri: notebookUri?.toString(),
				type: info.type,
			});

			// DataArray: show all actions including watch and ImageTool when ERLab is available.
			if (info.type === 'DataArray') {
				if (erlabAvailable) {
					if (!watchAvailable) {
						md.appendMarkdown(
							`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
							`[$(empty-window) ImageTool](command:erlab.xarray.openInImageTool?${hoverArgs}) | ` +
							`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString(), reveal: !isPinned })}) | ` +
							`[$(ellipsis) More...](command:erlab.xarray.otherTools?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })})\n`
						);
					} else if (info.watched) {
						md.appendMarkdown(
							`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
							`[$(eye) Show](command:erlab.watch?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })}) | ` +
							`[$(eye-closed) Unwatch](command:erlab.unwatch?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })}) | ` +
							`[$(empty-window) ImageTool](command:erlab.xarray.openInImageTool?${hoverArgs}) | ` +
							`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString(), reveal: !isPinned })}) | ` +
							`[$(ellipsis) More...](command:erlab.xarray.otherTools?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })})\n`
						);
					} else {
						md.appendMarkdown(
							`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
							`[$(eye) Watch](command:erlab.watch?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })}) | ` +
							`[$(empty-window) ImageTool](command:erlab.xarray.openInImageTool?${hoverArgs}) | ` +
							`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString(), reveal: !isPinned })}) | ` +
							`[$(ellipsis) More...](command:erlab.xarray.otherTools?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString() })})\n`
						);
					}
				} else {
					md.appendMarkdown(
						`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
						`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString(), reveal: !isPinned })})\n\n`
					);
				}
			} else {
				// Dataset and DataTree: only show Details and Pin
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.xarray.openDetail?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.xarray.togglePin?${encodeCommandArgs({ variableName, notebookUri: notebookUri.toString(), reveal: !isPinned })})\n\n`
				);
			}
			md.isTrusted = true;

			return new vscode.Hover(md, range);
		}
	});
}

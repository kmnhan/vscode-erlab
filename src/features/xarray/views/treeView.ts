/**
 * xarray objects tree view provider for the side panel.
 */
import * as vscode from 'vscode';
import type { PinnedXarrayStore } from './pinnedStore';
import type { XarrayEntry, XarrayObjectType } from '../types';
import { formatDimsWithSizes } from '../formatting';
import { refreshXarrayCache, getCachedXarrayEntries, getPendingRefresh } from '../service';
import { getActiveNotebookUri } from '../../../notebook';
import { logger } from '../../../logger';

export class XarrayPanelProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly pinnedStore: PinnedXarrayStore;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private treeView?: vscode.TreeView<vscode.TreeItem>;
	private itemsByName = new Map<string, XarrayTreeItem>();
	private lastItems: vscode.TreeItem[] = [];
	private refreshPending = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private executionInProgress = false;

	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(pinnedStore: PinnedXarrayStore) {
		this.pinnedStore = pinnedStore;
	}

	setTreeView(view: vscode.TreeView<vscode.TreeItem>): void {
		this.treeView = view;
	}

	requestRefresh(): void {
		if (this.executionInProgress) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			logger.trace('Tree view refresh deferred: execution in progress');
			return;
		}
		if (!this.treeView || !this.treeView.visible) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			logger.trace('Tree view refresh deferred: view not visible');
			return;
		}
		this.refreshPending = false;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.onDidChangeTreeDataEmitter.fire(undefined);
		}, 250);
		logger.trace('Tree view refresh scheduled');
	}

	setExecutionInProgress(active: boolean): void {
		this.executionInProgress = active;
		if (!active && this.refreshPending) {
			this.requestRefresh();
		}
	}

	async reveal(variableName: string): Promise<void> {
		const item = this.itemsByName.get(variableName);
		if (!item || !this.treeView) {
			return;
		}
		try {
			await this.treeView.reveal(item, { focus: true, select: true, expand: false });
		} catch {
			// Ignore reveal failures for stale items.
		}
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		if (this.executionInProgress) {
			return this.lastItems.length > 0
				? this.lastItems
				: [new XarrayMessageItem('Refreshing after cell execution…')];
		}

		const notebookUri = getActiveNotebookUri();
		if (!notebookUri) {
			this.itemsByName.clear();
			this.lastItems = [new XarrayMessageItem('Open a notebook to see xarray objects.')];
			return this.lastItems;
		}
		// Try to get cached entries first
		let entries = getCachedXarrayEntries(notebookUri);
		if (entries.length === 0) {
			// Check if there's already a refresh in progress, await it instead of triggering a new one
			const pending = getPendingRefresh(notebookUri);
			if (pending) {
				logger.trace('Tree view awaiting pending refresh');
				const result = await pending;
				if (result.error) {
					this.itemsByName.clear();
					this.lastItems = [new XarrayMessageItem(result.error)];
					return this.lastItems;
				}
				entries = result.entries;
			} else {
				// No pending refresh and cache is empty - trigger one
				const result = await refreshXarrayCache(notebookUri);
				if (result.error) {
					this.itemsByName.clear();
					this.lastItems = [new XarrayMessageItem(result.error)];
					return this.lastItems;
				}
				entries = result.entries;
			}
		}
		if (entries.length === 0) {
			this.itemsByName.clear();
			this.lastItems = [new XarrayMessageItem('No xarray objects found in the active notebook.')];
			return this.lastItems;
		}
		const pinned = this.pinnedStore.getPinned(notebookUri);
		const entryMap = new Map(entries.map((entry) => [entry.variableName, entry]));
		const prunedPinned = pinned.filter((name) => entryMap.has(name));
		if (prunedPinned.length !== pinned.length) {
			await this.pinnedStore.setPinned(notebookUri, prunedPinned);
		}
		const pinnedEntries = prunedPinned.map((name) => entryMap.get(name)).filter(Boolean) as XarrayEntry[];
		const unpinnedEntries = entries
			.filter((entry) => !prunedPinned.includes(entry.variableName))
			.sort((a, b) => a.variableName.localeCompare(b.variableName));
		const ordered = [...pinnedEntries, ...unpinnedEntries];
		this.itemsByName = new Map(
			ordered.map((entry) => [entry.variableName, new XarrayTreeItem(entry, notebookUri, prunedPinned.includes(entry.variableName))])
		);
		this.lastItems = Array.from(this.itemsByName.values());
		return this.lastItems;
	}
}

/**
 * @deprecated Use XarrayPanelProvider instead
 */
export const DataArrayPanelProvider = XarrayPanelProvider;

/**
 * Get the icon for an xarray object type.
 */
function getIconForType(type: XarrayObjectType, watched: boolean): vscode.ThemeIcon {
	if (watched) {
		return new vscode.ThemeIcon('eye');
	}
	switch (type) {
		case 'DataArray':
			return new vscode.ThemeIcon('symbol-array');
		case 'Dataset':
			return new vscode.ThemeIcon('symbol-namespace');
		case 'DataTree':
			return new vscode.ThemeIcon('list-tree');
	}
}

/**
 * Get the context value prefix for an xarray object type.
 */
function getContextValuePrefix(type: XarrayObjectType): string {
	switch (type) {
		case 'DataArray':
			return 'dataArrayItem';
		case 'Dataset':
			return 'datasetItem';
		case 'DataTree':
			return 'datatreeItem';
	}
}

export class XarrayTreeItem extends vscode.TreeItem {
	readonly variableName: string;
	readonly info: XarrayEntry;
	readonly notebookUri: vscode.Uri;
	readonly pinned: boolean;

	constructor(info: XarrayEntry, notebookUri: vscode.Uri, pinned: boolean) {
		super(info.variableName, vscode.TreeItemCollapsibleState.None);
		this.variableName = info.variableName;
		this.info = info;
		this.notebookUri = notebookUri;
		this.pinned = pinned;

		const watched = info.type === 'DataArray' && info.watched === true;
		const prefix = getContextValuePrefix(info.type);

		// Build description based on type
		if (info.type === 'DataArray' && info.dims && info.sizes) {
			const dimsLabel = formatDimsWithSizes(info.dims, info.sizes);
			const namePrefix = info.name ? `'${info.name}' ` : '';
			this.description = dimsLabel ? `${namePrefix}(${dimsLabel})` : namePrefix.trim();
		} else {
			// Dataset and DataTree show just the type
			this.description = info.type;
		}

		// Build tooltip
		const statusIcons = [
			pinned ? '$(pin) pinned' : '',
			watched ? '$(eye) watched' : '',
		].filter(Boolean);
		const statusLine = statusIcons.length > 0 ? `- status: ${statusIcons.join(' ')}\n` : '';

		let tooltipContent = `**${info.variableName}** (${info.type})\n\n${statusLine}`;
		if (info.type === 'DataArray' && info.dims && info.sizes && info.shape && info.dtype !== undefined && info.ndim !== undefined) {
			const dimsLabel = formatDimsWithSizes(info.dims, info.sizes);
			tooltipContent +=
				`- name: ${info.name ?? '—'}\n` +
				`- dims: ${dimsLabel || 'none'}\n` +
				`- shape: ${info.shape.length ? info.shape.join('x') : 'scalar'}\n` +
				`- dtype: ${info.dtype}\n` +
				`- ndim: ${info.ndim}`;
		} else {
			tooltipContent += `- name: ${info.name ?? '—'}`;
		}

		const tooltip = new vscode.MarkdownString(tooltipContent);
		tooltip.supportThemeIcons = true;
		this.tooltip = tooltip;

		this.iconPath = getIconForType(info.type, watched);

		this.command = {
			command: 'erlab.xarray.openDetail',
			title: 'Open Details',
			arguments: [{
				variableName: info.variableName,
				notebookUri: notebookUri.toString(),
				ndim: info.ndim,
				type: info.type,
			}],
		};

		// Set context value based on type and state
		if (info.type === 'DataArray') {
			if (pinned && watched) {
				this.contextValue = 'dataArrayItemPinnedWatched';
			} else if (pinned) {
				this.contextValue = 'dataArrayItemPinned';
			} else if (watched) {
				this.contextValue = 'dataArrayItemWatched';
			} else {
				this.contextValue = 'dataArrayItem';
			}
		} else {
			// Dataset and DataTree: only pinned state matters
			this.contextValue = pinned ? `${prefix}Pinned` : prefix;
		}
	}
}

/**
 * @deprecated Use XarrayTreeItem instead
 */
export const DataArrayTreeItem = XarrayTreeItem;

export class XarrayMessageItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'xarrayMessage';
	}
}

/**
 * @deprecated Use XarrayMessageItem instead
 */
export const DataArrayMessageItem = XarrayMessageItem;

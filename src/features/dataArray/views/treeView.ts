/**
 * DataArray tree view provider for the side panel.
 */
import * as vscode from 'vscode';
import type { PinnedDataArrayStore } from './pinnedStore';
import type { DataArrayEntry } from '../types';
import { formatDimsWithSizes } from '../formatting';
import { refreshDataArrayCache, getCachedDataArrayEntries } from '../service';
import { getActiveNotebookUri } from '../../../notebook';
import { logger } from '../../../logger';

export class DataArrayPanelProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly pinnedStore: PinnedDataArrayStore;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private treeView?: vscode.TreeView<vscode.TreeItem>;
	private itemsByName = new Map<string, DataArrayTreeItem>();
	private lastItems: vscode.TreeItem[] = [];
	private refreshPending = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private executionInProgress = false;

	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(pinnedStore: PinnedDataArrayStore) {
		this.pinnedStore = pinnedStore;
	}

	setTreeView(view: vscode.TreeView<vscode.TreeItem>): void {
		this.treeView = view;
	}

	requestRefresh(): void {
		logger.debug('Tree view refresh requested');
		if (this.executionInProgress) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			logger.trace('Refresh deferred: execution in progress');
			return;
		}
		if (!this.treeView || !this.treeView.visible) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
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
				: [new DataArrayMessageItem('Refreshing after cell execution…')];
		}

		const notebookUri = getActiveNotebookUri();
		if (!notebookUri) {
			this.itemsByName.clear();
			this.lastItems = [new DataArrayMessageItem('Open a notebook to see DataArrays.')];
			return this.lastItems;
		}
		// Try to get cached entries first, refresh cache if empty
		let entries = getCachedDataArrayEntries(notebookUri);
		if (entries.length === 0) {
			const result = await refreshDataArrayCache(notebookUri);
			if (result.error) {
				this.itemsByName.clear();
				this.lastItems = [new DataArrayMessageItem(result.error)];
				return this.lastItems;
			}
			entries = result.entries;
		}
		if (entries.length === 0) {
			this.itemsByName.clear();
			this.lastItems = [new DataArrayMessageItem('No DataArrays found in the active notebook.')];
			return this.lastItems;
		}
		const pinned = this.pinnedStore.getPinned(notebookUri);
		const entryMap = new Map(entries.map((entry) => [entry.variableName, entry]));
		const prunedPinned = pinned.filter((name) => entryMap.has(name));
		if (prunedPinned.length !== pinned.length) {
			await this.pinnedStore.setPinned(notebookUri, prunedPinned);
		}
		const pinnedEntries = prunedPinned.map((name) => entryMap.get(name)).filter(Boolean) as DataArrayEntry[];
		const unpinnedEntries = entries
			.filter((entry) => !prunedPinned.includes(entry.variableName))
			.sort((a, b) => a.variableName.localeCompare(b.variableName));
		const ordered = [...pinnedEntries, ...unpinnedEntries];
		this.itemsByName = new Map(
			ordered.map((entry) => [entry.variableName, new DataArrayTreeItem(entry, notebookUri, prunedPinned.includes(entry.variableName))])
		);
		this.lastItems = Array.from(this.itemsByName.values());
		return this.lastItems;
	}
}

export class DataArrayTreeItem extends vscode.TreeItem {
	readonly variableName: string;
	readonly info: DataArrayEntry;
	readonly notebookUri: vscode.Uri;
	readonly pinned: boolean;

	constructor(info: DataArrayEntry, notebookUri: vscode.Uri, pinned: boolean) {
		super(info.variableName, vscode.TreeItemCollapsibleState.None);
		this.variableName = info.variableName;
		this.info = info;
		this.notebookUri = notebookUri;
		this.pinned = pinned;

		const dimsLabel = formatDimsWithSizes(info.dims, info.sizes);
		const namePrefix = info.name ? `'${info.name}' ` : '';
		const descriptionLabel = dimsLabel ? `${namePrefix}(${dimsLabel})` : namePrefix.trim();
		this.description = descriptionLabel;
		const statusIcons = [
			pinned ? '$(pin) pinned' : '',
			info.watched ? '$(eye) watched' : '',
		].filter(Boolean);
		const statusLine = statusIcons.length > 0 ? `- status: ${statusIcons.join(' ')}\n` : '';
		const tooltip = new vscode.MarkdownString(
			`**${info.variableName}**\n\n` +
			`${statusLine}` +
			`- name: ${info.name ?? '—'}\n` +
			`- dims: ${dimsLabel || 'none'}\n` +
			`- shape: ${info.shape.length ? info.shape.join('x') : 'scalar'}\n` +
			`- dtype: ${info.dtype}\n` +
			`- ndim: ${info.ndim}`
		);
		tooltip.supportThemeIcons = true;
		this.tooltip = tooltip;
		this.iconPath = undefined;
		this.command = {
			command: 'erlab.dataArray.openDetail',
			title: 'Open DataArray Details',
			arguments: [{
				variableName: info.variableName,
				notebookUri: notebookUri.toString(),
				ndim: info.ndim,
			}],
		};
		if (pinned && info.watched) {
			this.contextValue = 'dataArrayItemPinnedWatched';
		} else if (pinned) {
			this.contextValue = 'dataArrayItemPinned';
		} else if (info.watched) {
			this.contextValue = 'dataArrayItemWatched';
		} else {
			this.contextValue = 'dataArrayItem';
		}
	}
}

export class DataArrayMessageItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'dataArrayMessage';
	}
}

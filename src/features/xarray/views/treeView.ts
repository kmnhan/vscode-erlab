/**
 * xarray objects tree view provider for the side panel.
 */
import * as vscode from 'vscode';
import type { PinnedXarrayStore } from './pinnedStore';
import type { XarrayEntry, XarrayObjectType } from '../types';
import { formatDimsWithSizes } from '../formatting';
import {
	refreshXarrayCache,
	getCachedXarrayEntries,
	getPendingRefresh,
	getXarrayListAutoRefreshDelayMs,
	isXarrayListStale,
	shouldAutoRefreshXarrayList,
} from '../service';
import { getActiveNotebookUri } from '../../../notebook';
import { logger } from '../../../logger';
import { setNonBlockingTimeout } from '../../../timers';

const TYPE_FILTER_STORAGE_KEY = 'erlab.xarray.typeFilters';
const DEFAULT_TYPE_FILTERS: XarrayObjectType[] = ['DataArray', 'Dataset', 'DataTree'];

function isXarrayType(value: unknown): value is XarrayObjectType {
	return value === 'DataArray' || value === 'Dataset' || value === 'DataTree';
}

function normalizeTypeFilters(value: unknown): XarrayObjectType[] {
	if (!Array.isArray(value)) {
		return DEFAULT_TYPE_FILTERS;
	}
	if (value.length === 0) {
		return [];
	}
	const normalized = value.filter(isXarrayType);
	return normalized.length > 0 ? normalized : DEFAULT_TYPE_FILTERS;
}

export class XarrayPanelProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
	private readonly pinnedStore: PinnedXarrayStore;
	private readonly onDidAccessNotebook?: (notebookUri: vscode.Uri) => void | Promise<void>;
	private readonly typeFilterState?: vscode.Memento;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private treeView?: vscode.TreeView<vscode.TreeItem>;
	private itemsByName = new Map<string, XarrayTreeItem>();
	private lastItems: vscode.TreeItem[] = [];
	private refreshPending = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private passiveRetryTimer: NodeJS.Timeout | undefined;
	private passiveRetryNotebookKey: string | undefined;
	private pendingSelection: { variableName: string; focus: boolean } | undefined;
	private typeFilters: Set<XarrayObjectType>;
	private readonly executingNotebookKeys = new Set<string>();
	private disposed = false;

	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(
		pinnedStore: PinnedXarrayStore,
		options?: {
			onDidAccessNotebook?: (notebookUri: vscode.Uri) => void | Promise<void>;
			typeFilterState?: vscode.Memento;
		}
	) {
		this.pinnedStore = pinnedStore;
		this.onDidAccessNotebook = options?.onDidAccessNotebook;
		this.typeFilterState = options?.typeFilterState;
		const storedFilters = this.typeFilterState?.get<XarrayObjectType[]>(TYPE_FILTER_STORAGE_KEY);
		this.typeFilters = new Set(normalizeTypeFilters(storedFilters));
	}

	setTreeView(view: vscode.TreeView<vscode.TreeItem>): void {
		if (this.disposed) {
			return;
		}
		this.treeView = view;
		void this.applyPendingSelection();
	}

	getTypeFilters(): XarrayObjectType[] {
		return Array.from(this.typeFilters);
	}

	async setTypeFilters(filters: Iterable<XarrayObjectType>): Promise<void> {
		this.typeFilters = new Set(filters);
		if (this.typeFilterState) {
			await this.typeFilterState.update(TYPE_FILTER_STORAGE_KEY, Array.from(this.typeFilters));
		}
		this.requestRefresh();
	}

	private clearPassiveRetryTimer(notebookUri?: vscode.Uri): void {
		if (!this.passiveRetryTimer) {
			return;
		}
		if (
			notebookUri
			&& this.passiveRetryNotebookKey
			&& this.passiveRetryNotebookKey !== notebookUri.toString()
		) {
			return;
		}
		clearTimeout(this.passiveRetryTimer);
		this.passiveRetryTimer = undefined;
		this.passiveRetryNotebookKey = undefined;
	}

	private schedulePassiveRetryRefresh(notebookUri: vscode.Uri): void {
		const delayMs = getXarrayListAutoRefreshDelayMs(notebookUri);
		if (typeof delayMs !== 'number' || delayMs <= 0) {
			this.clearPassiveRetryTimer(notebookUri);
			return;
		}
		const notebookKey = notebookUri.toString();
		if (this.passiveRetryTimer && this.passiveRetryNotebookKey === notebookKey) {
			return;
		}
		this.clearPassiveRetryTimer();
		this.passiveRetryNotebookKey = notebookKey;
		this.passiveRetryTimer = setNonBlockingTimeout(() => {
			this.passiveRetryTimer = undefined;
			this.passiveRetryNotebookKey = undefined;
			this.requestRefresh();
		}, delayMs);
	}

	private isNotebookExecutionInProgress(notebookUri: vscode.Uri | undefined): boolean {
		return notebookUri ? this.executingNotebookKeys.has(notebookUri.toString()) : false;
	}

	isVisibleForNotebook(notebookUri: vscode.Uri): boolean {
		if (this.disposed || !this.treeView?.visible) {
			return false;
		}
		return this.getResolvedNotebookUri()?.toString() === notebookUri.toString();
	}

	requestRefresh(): void {
		if (this.disposed) {
			return;
		}
		const refreshNotebookUri = this.getResolvedNotebookUri();
		if (refreshNotebookUri) {
			this.clearPassiveRetryTimer(refreshNotebookUri);
		} else {
			this.clearPassiveRetryTimer();
		}
		if (this.isNotebookExecutionInProgress(refreshNotebookUri)) {
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
		this.refreshTimer = setNonBlockingTimeout(() => {
			if (this.disposed) {
				return;
			}
			this.refreshTimer = undefined;
			this.onDidChangeTreeDataEmitter.fire(undefined);
		}, 250);
		logger.trace('Tree view refresh scheduled');
	}

	setNotebookExecutionInProgress(notebookUri: vscode.Uri, active: boolean): void {
		if (this.disposed) {
			return;
		}
		const notebookKey = notebookUri.toString();
		if (active) {
			this.executingNotebookKeys.add(notebookKey);
			return;
		}
		this.executingNotebookKeys.delete(notebookKey);
		if (this.refreshPending && this.isVisibleForNotebook(notebookUri)) {
			this.requestRefresh();
		}
	}

	async reveal(variableName: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.pendingSelection = { variableName, focus: true };
		await this.revealItem(variableName, true);
	}

	async select(variableName: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.pendingSelection = { variableName, focus: false };
		await this.revealItem(variableName, false);
	}

	private async revealItem(variableName: string, focus: boolean): Promise<void> {
		if (this.disposed) {
			return;
		}
		const item = this.itemsByName.get(variableName);
		if (!item || !this.treeView) {
			return;
		}
		try {
			await this.treeView.reveal(item, { focus, select: true, expand: false });
			this.pendingSelection = undefined;
		} catch {
			// Ignore reveal failures for stale items.
		}
	}

	private async applyPendingSelection(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (!this.pendingSelection || !this.treeView || !this.treeView.visible) {
			return;
		}
		const pending = this.pendingSelection;
		const item = this.itemsByName.get(pending.variableName);
		if (!item) {
			return;
		}
		this.pendingSelection = undefined;
		try {
			await this.treeView.reveal(item, { focus: pending.focus, select: true, expand: false });
		} catch {
			this.pendingSelection = pending;
		}
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	getParent(_element: vscode.TreeItem): vscode.TreeItem | undefined {
		return;
	}

	private getResolvedNotebookUri(): vscode.Uri | undefined {
		return getActiveNotebookUri();
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		if (this.disposed) {
			return [];
		}
		const notebookUri = this.getResolvedNotebookUri();
		if (!notebookUri) {
			this.clearPassiveRetryTimer();
			this.itemsByName.clear();
			this.lastItems = [new XarrayMessageItem('Open a notebook to see xarray objects.')];
			return this.lastItems;
		}
		if (this.isNotebookExecutionInProgress(notebookUri)) {
			return this.lastItems.length > 0
				? this.lastItems
				: [new XarrayMessageItem('Refreshing after cell execution…')];
		}
		void this.onDidAccessNotebook?.(notebookUri);
		const cachedEntries = getCachedXarrayEntries(notebookUri);
		let entries = cachedEntries;
		const listStale = isXarrayListStale(notebookUri);
		const shouldAutoRefresh = shouldAutoRefreshXarrayList(notebookUri);
		if (listStale && !shouldAutoRefresh) {
			this.schedulePassiveRetryRefresh(notebookUri);
		} else {
			this.clearPassiveRetryTimer(notebookUri);
		}
		const needsRefresh = listStale && shouldAutoRefresh;
		if (needsRefresh) {
			// Check if there's already a refresh in progress, await it instead of triggering a new one
			const pending = getPendingRefresh(notebookUri);
			if (pending) {
				logger.trace('Tree view awaiting pending refresh');
				const result = await pending;
				if (result.error) {
					this.schedulePassiveRetryRefresh(notebookUri);
					if (cachedEntries.length > 0) {
						entries = cachedEntries;
					} else {
						this.itemsByName.clear();
						this.lastItems = [new XarrayMessageItem(result.error)];
						return this.lastItems;
					}
				} else {
					entries = result.entries;
				}
			} else {
				// No pending refresh and cache is stale or empty - trigger one
				const result = await refreshXarrayCache(notebookUri);
				if (result.error) {
					this.schedulePassiveRetryRefresh(notebookUri);
					if (cachedEntries.length > 0) {
						entries = cachedEntries;
					} else {
						this.itemsByName.clear();
						this.lastItems = [new XarrayMessageItem(result.error)];
						return this.lastItems;
					}
				} else {
					entries = result.entries;
				}
			}
		}
		if (listStale && !shouldAutoRefresh && entries.length === 0) {
			this.itemsByName.clear();
			this.lastItems = [new XarrayMessageItem('Waiting to retry xarray refresh after a recent failure.')];
			return this.lastItems;
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
		const pinnedSet = new Set(prunedPinned);
		const visibleEntries = entries.filter((entry) => this.typeFilters.has(entry.type));
		if (visibleEntries.length === 0) {
			this.itemsByName.clear();
			this.lastItems = [
				new XarrayMessageItem(
					this.typeFilters.size === 0
						? 'No xarray types selected. Use the filter button to show objects.'
						: 'No xarray objects match the current filters.'
				),
			];
			return this.lastItems;
		}
		const pinnedEntries = prunedPinned
			.map((name) => entryMap.get(name))
			.filter((entry): entry is XarrayEntry => {
				if (!entry) {
					return false;
				}
				return this.typeFilters.has(entry.type);
			});
		const unpinnedEntries = visibleEntries
			.filter((entry) => !pinnedSet.has(entry.variableName))
			.sort((a, b) => a.variableName.localeCompare(b.variableName));
		const ordered = [...pinnedEntries, ...unpinnedEntries];
		this.itemsByName = new Map(
			ordered.map((entry) => [entry.variableName, new XarrayTreeItem(entry, notebookUri, pinnedSet.has(entry.variableName))])
		);
		this.lastItems = Array.from(this.itemsByName.values());
		void this.applyPendingSelection();
		return this.lastItems;
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.clearPassiveRetryTimer();
		this.refreshPending = false;
		this.pendingSelection = undefined;
		this.executingNotebookKeys.clear();
		this.itemsByName.clear();
		this.lastItems = [];
		this.treeView = undefined;
		this.onDidChangeTreeDataEmitter.dispose();
	}
}

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
		const watchAvailable = info.type === 'DataArray' && info.watchAvailable !== false;
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
			if (!watchAvailable) {
				this.contextValue = pinned ? 'dataArrayItemPinnedNoWatch' : 'dataArrayItemNoWatch';
			} else if (pinned && watched) {
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

export class XarrayMessageItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'xarrayMessage';
	}
}

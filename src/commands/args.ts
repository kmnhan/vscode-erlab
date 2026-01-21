/**
 * Command argument utilities for encoding and normalizing command args.
 */
import type { XarrayTreeItem } from '../features/xarray/views/treeView';
import type { XarrayObjectType } from '../features/xarray/types';
import { isDataArrayEntry } from '../features/xarray/types';

export type MagicCommandArgs = { variableName?: string };

export type XarrayPanelCommandArgs = {
	variableName?: string;
	notebookUri?: string;
	watched?: boolean;
	ndim?: number;
	reveal?: boolean;
	type?: XarrayObjectType;
};

/**
 * Encode command arguments as a URL-safe string for command URIs.
 */
export function encodeCommandArgs(args: Record<string, unknown>): string {
	return encodeURIComponent(JSON.stringify(args));
}

/**
 * Normalize xarray command arguments, handling both plain objects and TreeItem instances.
 */
export function normalizeXarrayArgs(
	args?: XarrayPanelCommandArgs | XarrayTreeItem
): XarrayPanelCommandArgs | undefined {
	if (!args) {
		return;
	}
	// Check if this is an XarrayTreeItem by looking for its unique properties
	if ('variableName' in args && 'info' in args && 'notebookUri' in args) {
		const treeItem = args as XarrayTreeItem;
		const isDataArray = treeItem.info.type === 'DataArray';
		return {
			variableName: treeItem.variableName,
			notebookUri: treeItem.notebookUri.toString(),
			watched: isDataArray ? Boolean(treeItem.info.watched) : false,
			ndim: isDataArrayEntry(treeItem.info) ? treeItem.info.ndim : undefined,
			type: treeItem.info.type,
		};
	}
	return args as XarrayPanelCommandArgs;
}

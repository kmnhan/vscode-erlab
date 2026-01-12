/**
 * Command argument utilities for encoding and normalizing command args.
 */
import type { DataArrayTreeItem } from '../features/dataArray/views/treeView';

export type MagicCommandArgs = { variableName?: string };

export type DataArrayPanelCommandArgs = {
	variableName?: string;
	notebookUri?: string;
	watched?: boolean;
	ndim?: number;
	reveal?: boolean;
};

/**
 * Encode command arguments as a URL-safe string for command URIs.
 */
export function encodeCommandArgs(args: Record<string, unknown>): string {
	return encodeURIComponent(JSON.stringify(args));
}

/**
 * Normalize DataArray command arguments, handling both plain objects and TreeItem instances.
 */
export function normalizeDataArrayArgs(
	args?: DataArrayPanelCommandArgs | DataArrayTreeItem
): DataArrayPanelCommandArgs | undefined {
	if (!args) {
		return;
	}
	// Check if this is a DataArrayTreeItem by looking for its unique properties
	if ('variableName' in args && 'info' in args && 'notebookUri' in args) {
		const treeItem = args as DataArrayTreeItem;
		return {
			variableName: treeItem.variableName,
			notebookUri: treeItem.notebookUri.toString(),
			watched: treeItem.info.watched,
			ndim: treeItem.info.ndim,
		};
	}
	return args as DataArrayPanelCommandArgs;
}

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

export type JupyterVariableViewerArgs = {
	name?: unknown;
	type?: unknown;
	fileName?: unknown;
	notebookUri?: unknown;
	uri?: unknown;
	variableName?: unknown;
};

function isXarrayObjectType(value: unknown): value is XarrayObjectType {
	return value === 'DataArray' || value === 'Dataset' || value === 'DataTree';
}

function coerceNotebookUri(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (!value || typeof value !== 'object') {
		return;
	}
	const candidate = value as { scheme?: unknown; path?: unknown; toString?: () => string };
	if (typeof candidate.scheme !== 'string' || typeof candidate.path !== 'string') {
		return;
	}
	if (typeof candidate.toString !== 'function') {
		return;
	}
	const text = candidate.toString();
	return typeof text === 'string' ? text : undefined;
}

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

/**
 * Normalize variable viewer args into xarray command args.
 */
export function normalizeJupyterVariableViewerArgs(
	args?: unknown
): XarrayPanelCommandArgs | undefined {
	if (!args) {
		return;
	}
	const root = Array.isArray(args) ? args[0] : args;
	if (!root || typeof root !== 'object') {
		return;
	}
	const wrapped = root as { variable?: unknown };
	const candidate = wrapped.variable && typeof wrapped.variable === 'object' ? wrapped.variable : root;
	const variableArgs = candidate as JupyterVariableViewerArgs;
	const name = typeof variableArgs.name === 'string'
		? variableArgs.name
		: typeof variableArgs.variableName === 'string'
			? variableArgs.variableName
			: undefined;
	if (!name) {
		return;
	}
	return {
		variableName: name,
		notebookUri: coerceNotebookUri(variableArgs.fileName)
			?? coerceNotebookUri(variableArgs.notebookUri)
			?? coerceNotebookUri(variableArgs.uri),
		type: isXarrayObjectType(variableArgs.type) ? variableArgs.type : undefined,
	};
}

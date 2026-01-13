/**
 * DataArray service for querying and caching DataArray info from the kernel.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../kernel';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { type DataArrayEntry } from './types';
import { buildDataArrayQueryCode } from './pythonSnippets';
import { logger } from '../../logger';

/**
 * Cache structure: notebookUri -> Map<variableName, DataArrayEntry>
 * This cache is only refreshed on cell execution completion.
 */
const dataArrayCache = new Map<string, Map<string, DataArrayEntry>>();

/**
 * Get the cache key for a notebook URI.
 */
function getNotebookCacheKey(notebookUri: vscode.Uri): string {
	return notebookUri.toString();
}

/**
 * Parse the response from the kernel into DataArrayEntry objects.
 */
function parseDataArrayResponse(output: string): { entries: DataArrayEntry[]; error?: string } {
	const line = extractLastJsonLine(output);
	if (!line) {
		return { entries: [], error: 'No response from the kernel. Run a cell and refresh.' };
	}

	const parsed = JSON.parse(line) as Array<{
		variableName?: string;
		name?: string | null;
		dims?: string[];
		sizes?: Record<string, number>;
		shape?: number[];
		dtype?: string;
		ndim?: number;
		watched?: boolean;
		error?: string;
	}> | { error?: string };

	if (!Array.isArray(parsed)) {
		return { entries: [], error: parsed?.error ?? 'Kernel returned unexpected data.' };
	}

	const entries = parsed
		.filter((entry) =>
			entry &&
			entry.variableName &&
			entry.dims &&
			entry.sizes &&
			entry.shape &&
			entry.dtype &&
			typeof entry.ndim === 'number'
		)
		.filter((entry) => isValidPythonIdentifier(entry.variableName as string))
		.map((entry) => ({
			variableName: entry.variableName as string,
			name: entry.name ?? undefined,
			dims: entry.dims as string[],
			sizes: entry.sizes as Record<string, number>,
			shape: entry.shape as number[],
			dtype: entry.dtype as string,
			ndim: entry.ndim as number,
			watched: entry.watched ?? false,
		}));

	return { entries };
}

/**
 * Refresh the DataArray cache for a notebook by querying the kernel.
 * This queries all DataArrays in the namespace and updates the cache.
 */
export async function refreshDataArrayCache(
	notebookUri: vscode.Uri
): Promise<{ entries: DataArrayEntry[]; error?: string }> {
	const cacheKey = getNotebookCacheKey(notebookUri);
	logger.info(`Refreshing DataArray cache for ${notebookUri.fsPath}`);

	try {
		const output = await executeInKernelForOutput(notebookUri, buildDataArrayQueryCode());
		const { entries, error } = parseDataArrayResponse(output);

		if (error) {
			// On error, clear the cache for this notebook
			dataArrayCache.delete(cacheKey);
			logger.warn(`DataArray cache refresh failed: ${error}`);
			return { entries: [], error };
		}

		// Update the cache with all entries
		const notebookCache = new Map<string, DataArrayEntry>();
		for (const entry of entries) {
			notebookCache.set(entry.variableName, entry);
		}
		dataArrayCache.set(cacheKey, notebookCache);

		logger.debug(`DataArray cache updated: found ${entries.length} DataArrays`);
		return { entries };
	} catch (err) {
		dataArrayCache.delete(cacheKey);
		const message = 'Failed to query the kernel. Ensure the Jupyter kernel is running.';
		logger.error(`DataArray cache refresh error: ${err instanceof Error ? err.message : String(err)}`);
		return { entries: [], error: message };
	}
}

/**
 * Get a DataArray entry from the cache (synchronous, no kernel query).
 * Returns undefined if not found in cache.
 */
export function getCachedDataArrayEntry(
	notebookUri: vscode.Uri,
	variableName: string
): DataArrayEntry | undefined {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = dataArrayCache.get(cacheKey);
	return notebookCache?.get(variableName);
}

/**
 * Check if a variable name exists in the cache (synchronous).
 */
export function isDataArrayInCache(
	notebookUri: vscode.Uri,
	variableName: string
): boolean {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = dataArrayCache.get(cacheKey);
	return notebookCache?.has(variableName) ?? false;
}

/**
 * Get all cached DataArray entries for a notebook.
 */
export function getCachedDataArrayEntries(
	notebookUri: vscode.Uri
): DataArrayEntry[] {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = dataArrayCache.get(cacheKey);
	return notebookCache ? Array.from(notebookCache.values()) : [];
}

/**
 * Invalidate the cache for a specific variable (e.g., after watch/unwatch).
 */
export function invalidateDataArrayCacheEntry(
	notebookUri: vscode.Uri,
	variableName: string
): void {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = dataArrayCache.get(cacheKey);
	notebookCache?.delete(variableName);
}

/**
 * Clear the entire cache for a notebook.
 */
export function clearDataArrayCache(notebookUri: vscode.Uri): void {
	const cacheKey = getNotebookCacheKey(notebookUri);
	dataArrayCache.delete(cacheKey);
}

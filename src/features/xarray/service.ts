/**
 * xarray object service for querying and caching xarray object info from the kernel.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../kernel';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { type XarrayEntry, type XarrayObjectType } from './types';
import { buildXarrayQueryCode } from './pythonSnippets';
import { logger } from '../../logger';

/**
 * Cache structure: notebookUri -> Map<variableName, XarrayEntry>
 * This cache is only refreshed on cell execution completion.
 */
const xarrayCache = new Map<string, Map<string, XarrayEntry>>();

/**
 * Track in-flight refresh requests to avoid duplicate kernel queries.
 */
const pendingRefreshes = new Map<string, Promise<{ entries: XarrayEntry[]; error?: string }>>();

/**
 * Debounce timers for refresh requests per notebook.
 */
const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Debounce delay in milliseconds for coalescing rapid refresh requests.
 */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * Get the cache key for a notebook URI.
 */
function getNotebookCacheKey(notebookUri: vscode.Uri): string {
	return notebookUri.toString();
}

/**
 * Parse the response from the kernel into XarrayEntry objects.
 */
function parseXarrayResponse(output: string): { entries: XarrayEntry[]; error?: string } {
	const line = extractLastJsonLine(output);
	if (!line) {
		return { entries: [], error: 'No response from the kernel. Run a cell and refresh.' };
	}

	const parsed = JSON.parse(line) as Array<{
		variableName?: string;
		type?: XarrayObjectType;
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
			entry.type &&
			['DataArray', 'Dataset', 'DataTree'].includes(entry.type)
		)
		.filter((entry) => isValidPythonIdentifier(entry.variableName as string))
		.map((entry): XarrayEntry => {
			const base: XarrayEntry = {
				variableName: entry.variableName as string,
				type: entry.type as XarrayObjectType,
				name: entry.name ?? undefined,
			};
			// Add DataArray-specific fields if present
			if (entry.type === 'DataArray') {
				return {
					...base,
					dims: entry.dims as string[],
					sizes: entry.sizes as Record<string, number>,
					shape: entry.shape as number[],
					dtype: entry.dtype as string,
					ndim: entry.ndim as number,
					watched: entry.watched ?? false,
				};
			}
			return base;
		});

	return { entries };
}

/**
 * Internal function that performs the actual cache refresh.
 */
async function doRefreshXarrayCache(
	notebookUri: vscode.Uri,
	cacheKey: string
): Promise<{ entries: XarrayEntry[]; error?: string }> {
	logger.info(`Refreshing xarray cache for ${notebookUri.fsPath}`);

	try {
		const output = await executeInKernelForOutput(notebookUri, buildXarrayQueryCode(), {
			operation: 'xarray-query',
		});
		const { entries, error } = parseXarrayResponse(output);

		if (error) {
			// On error, clear the cache for this notebook
			xarrayCache.delete(cacheKey);
			logger.warn(`xarray cache refresh failed: ${error}`);
			return { entries: [], error };
		}

		// Update the cache with all entries
		const notebookCache = new Map<string, XarrayEntry>();
		for (const entry of entries) {
			notebookCache.set(entry.variableName, entry);
		}
		xarrayCache.set(cacheKey, notebookCache);

		logger.debug(`xarray cache updated: found ${entries.length} objects`);
		return { entries };
	} catch (err) {
		xarrayCache.delete(cacheKey);
		const message = err instanceof Error && err.message
			? err.message
			: 'Failed to query the kernel. Ensure the Jupyter kernel is running.';
		logger.error(`xarray cache refresh error: ${err instanceof Error ? err.message : String(err)}`);
		return { entries: [], error: message };
	} finally {
		// Clean up pending refresh tracking
		pendingRefreshes.delete(cacheKey);
	}
}

/**
 * Refresh the xarray cache for a notebook by querying the kernel.
 * This queries all xarray objects in the namespace and updates the cache.
 *
 * Requests are debounced (150ms) and coalesced: if a refresh is already
 * in-flight for this notebook, the existing promise is returned.
 */
export async function refreshXarrayCache(
	notebookUri: vscode.Uri
): Promise<{ entries: XarrayEntry[]; error?: string }> {
	const cacheKey = getNotebookCacheKey(notebookUri);

	// If there's already a refresh in progress, return that promise
	const pending = pendingRefreshes.get(cacheKey);
	if (pending) {
		logger.trace(`Reusing in-flight refresh for ${notebookUri.fsPath}`);
		return pending;
	}

	// Clear any existing debounce timer
	const existingTimer = debounceTimers.get(cacheKey);
	if (existingTimer) {
		clearTimeout(existingTimer);
	}

	// Create a debounced promise that will execute after the delay
	const refreshPromise = new Promise<{ entries: XarrayEntry[]; error?: string }>((resolve) => {
		const timer = setTimeout(async () => {
			debounceTimers.delete(cacheKey);
			const result = await doRefreshXarrayCache(notebookUri, cacheKey);
			resolve(result);
		}, REFRESH_DEBOUNCE_MS);
		debounceTimers.set(cacheKey, timer);
	});

	// Track this as the pending refresh
	pendingRefreshes.set(cacheKey, refreshPromise);

	return refreshPromise;
}

/**
 * @deprecated Use refreshXarrayCache instead
 */
export const refreshDataArrayCache = refreshXarrayCache;

/**
 * Get an xarray entry from the cache (synchronous, no kernel query).
 * Returns undefined if not found in cache.
 */
export function getCachedXarrayEntry(
	notebookUri: vscode.Uri,
	variableName: string
): XarrayEntry | undefined {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = xarrayCache.get(cacheKey);
	return notebookCache?.get(variableName);
}

/**
 * @deprecated Use getCachedXarrayEntry instead
 */
export const getCachedDataArrayEntry = getCachedXarrayEntry;

/**
 * Check if a variable name exists in the cache (synchronous).
 */
export function isXarrayInCache(
	notebookUri: vscode.Uri,
	variableName: string
): boolean {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = xarrayCache.get(cacheKey);
	return notebookCache?.has(variableName) ?? false;
}

/**
 * @deprecated Use isXarrayInCache instead
 */
export const isDataArrayInCache = isXarrayInCache;

/**
 * Get all cached xarray entries for a notebook.
 */
export function getCachedXarrayEntries(
	notebookUri: vscode.Uri
): XarrayEntry[] {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = xarrayCache.get(cacheKey);
	return notebookCache ? Array.from(notebookCache.values()) : [];
}

/**
 * @deprecated Use getCachedXarrayEntries instead
 */
export const getCachedDataArrayEntries = getCachedXarrayEntries;

/**
 * Get the pending refresh promise for a notebook, if any.
 * This allows callers to await an in-flight refresh without triggering a new one.
 */
export function getPendingRefresh(
	notebookUri: vscode.Uri
): Promise<{ entries: XarrayEntry[]; error?: string }> | undefined {
	const cacheKey = getNotebookCacheKey(notebookUri);
	return pendingRefreshes.get(cacheKey);
}

/**
 * Invalidate the cache for a specific variable (e.g., after watch/unwatch).
 */
export function invalidateXarrayCacheEntry(
	notebookUri: vscode.Uri,
	variableName: string
): void {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const notebookCache = xarrayCache.get(cacheKey);
	notebookCache?.delete(variableName);
}

/**
 * @deprecated Use invalidateXarrayCacheEntry instead
 */
export const invalidateDataArrayCacheEntry = invalidateXarrayCacheEntry;

/**
 * Clear the entire cache for a notebook.
 */
export function clearXarrayCache(notebookUri: vscode.Uri): void {
	const cacheKey = getNotebookCacheKey(notebookUri);
	xarrayCache.delete(cacheKey);
}

/**
 * @deprecated Use clearXarrayCache instead
 */
export const clearDataArrayCache = clearXarrayCache;

/**
 * xarray object service for querying and caching xarray object info from the kernel.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../kernel';
import { isValidPythonIdentifier } from '../../python/identifiers';
import { type XarrayEntry, type XarrayObjectType, isDataArrayEntry } from './types';
import { buildXarrayQueryCode } from './pythonSnippets';
import { logger } from '../../logger';

/**
 * Cache structure: notebookUri -> Map<variableName, XarrayEntry>
 * List refreshes store summary metadata; per-variable details are fetched on demand.
 */
const xarrayCache = new Map<string, Map<string, XarrayEntry>>();
const xarrayCacheMeta = new Map<string, Map<string, { updatedAt: number; hasDetails: boolean }>>();
const listCacheState = new Map<string, { updatedAt: number }>();

/**
 * Track in-flight refresh requests to avoid duplicate kernel queries.
 */
const pendingRefreshes = new Map<string, Promise<{ entries: XarrayEntry[]; error?: string }>>();
const pendingEntryRefreshes = new Map<string, Promise<{ entry?: XarrayEntry; error?: string }>>();

/**
 * Debounce timers for refresh requests per notebook.
 */
const debounceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Debounce delay in milliseconds for coalescing rapid refresh requests.
 */
const REFRESH_DEBOUNCE_MS = 300;
const ENTRY_STALE_MS = 2000;

/**
 * Get the cache key for a notebook URI.
 */
function getNotebookCacheKey(notebookUri: vscode.Uri): string {
	return notebookUri.toString();
}

function getNotebookCacheMeta(cacheKey: string): Map<string, { updatedAt: number; hasDetails: boolean }> {
	const meta = xarrayCacheMeta.get(cacheKey);
	if (meta) {
		return meta;
	}
	const next = new Map<string, { updatedAt: number; hasDetails: boolean }>();
	xarrayCacheMeta.set(cacheKey, next);
	return next;
}

function mergeDataArrayEntry(
	existing: XarrayEntry | undefined,
	incoming: XarrayEntry
): { entry: XarrayEntry; hasDetails: boolean } {
	if (incoming.type !== 'DataArray') {
		return { entry: incoming, hasDetails: false };
	}

	const incomingHasDetails = isDataArrayEntry(incoming);
	if (incomingHasDetails) {
		return { entry: incoming, hasDetails: true };
	}
	if (existing && existing.type === 'DataArray' && isDataArrayEntry(existing)) {
		return {
			entry: {
				...incoming,
				dims: existing.dims,
				sizes: existing.sizes,
				shape: existing.shape,
				dtype: existing.dtype,
				ndim: existing.ndim,
			},
			hasDetails: true,
		};
	}
	return { entry: incoming, hasDetails: false };
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
			if (entry.type !== 'DataArray') {
				return base;
			}
			const dataArray: XarrayEntry = {
				...base,
				watched: entry.watched ?? false,
			};
			const hasDetails = Array.isArray(entry.dims)
				&& entry.sizes
				&& typeof entry.sizes === 'object'
				&& Array.isArray(entry.shape)
				&& entry.dtype !== undefined
				&& entry.ndim !== undefined;
			if (hasDetails) {
				dataArray.dims = entry.dims as string[];
				dataArray.sizes = entry.sizes as Record<string, number>;
				dataArray.shape = entry.shape as number[];
				dataArray.dtype = entry.dtype as string;
				dataArray.ndim = entry.ndim as number;
			}
			return dataArray;
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
		const output = await executeInKernelForOutput(
			notebookUri,
			buildXarrayQueryCode(undefined, { includeDataArrayDetails: false }),
			{
				operation: 'xarray-query',
			}
		);
		const { entries, error } = parseXarrayResponse(output);

		if (error) {
			// On error, clear the cache for this notebook
			xarrayCache.delete(cacheKey);
			xarrayCacheMeta.delete(cacheKey);
			listCacheState.delete(cacheKey);
			logger.warn(`xarray cache refresh failed: ${error}`);
			return { entries: [], error };
		}

		// Update the cache with all entries, preserving existing details when possible
		const existingCache = xarrayCache.get(cacheKey);
		const existingMeta = xarrayCacheMeta.get(cacheKey);
		const notebookCache = new Map<string, XarrayEntry>();
		const notebookMeta = new Map<string, { updatedAt: number; hasDetails: boolean }>();
		const updatedAt = Date.now();
		for (const entry of entries) {
			const existing = existingCache?.get(entry.variableName);
			const merged = mergeDataArrayEntry(existing, entry);
			const existingHasDetails = existingMeta?.get(entry.variableName)?.hasDetails ?? false;
			const hasDetails = entry.type === 'DataArray'
				? (merged.hasDetails || existingHasDetails)
				: false;
			notebookCache.set(entry.variableName, merged.entry);
			notebookMeta.set(entry.variableName, { updatedAt, hasDetails });
		}
		xarrayCache.set(cacheKey, notebookCache);
		xarrayCacheMeta.set(cacheKey, notebookMeta);
		listCacheState.set(cacheKey, { updatedAt });

		logger.debug(`xarray cache updated: found ${entries.length} objects`);
		return { entries };
	} catch (err) {
		xarrayCache.delete(cacheKey);
		xarrayCacheMeta.delete(cacheKey);
		listCacheState.delete(cacheKey);
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
 * This queries all xarray objects in the namespace and stores summary metadata.
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

export async function refreshXarrayEntry(
	notebookUri: vscode.Uri,
	variableName: string,
	options?: { includeDetails?: boolean; reason?: string }
): Promise<{ entry?: XarrayEntry; error?: string }> {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const pendingKey = `${cacheKey}::${variableName}`;
	const pending = pendingEntryRefreshes.get(pendingKey);
	if (pending) {
		logger.trace(`Reusing in-flight entry refresh for ${variableName}`);
		return pending;
	}

	const refreshPromise = (async () => {
		try {
			const output = await executeInKernelForOutput(
				notebookUri,
				buildXarrayQueryCode(variableName, { includeDataArrayDetails: options?.includeDetails }),
				{ operation: options?.reason ? `xarray-entry:${options.reason}` : 'xarray-entry' }
			);
			const { entries, error } = parseXarrayResponse(output);
			if (error) {
				logger.warn(`xarray entry refresh failed: ${error}`);
				return { entry: undefined, error };
			}
			const entry = entries.find((candidate) => candidate.variableName === variableName);
			if (!entry) {
				xarrayCache.get(cacheKey)?.delete(variableName);
				xarrayCacheMeta.get(cacheKey)?.delete(variableName);
				return { entry: undefined };
			}
			const cache = xarrayCache.get(cacheKey) ?? new Map<string, XarrayEntry>();
			const existing = cache.get(variableName);
			const merged = mergeDataArrayEntry(existing, entry);
			cache.set(variableName, merged.entry);
			xarrayCache.set(cacheKey, cache);
			const meta = getNotebookCacheMeta(cacheKey);
			meta.set(variableName, { updatedAt: Date.now(), hasDetails: merged.hasDetails });
			return { entry: merged.entry };
		} catch (err) {
			const message = err instanceof Error && err.message
				? err.message
				: 'Failed to query the kernel. Ensure the Jupyter kernel is running.';
			logger.error(`xarray entry refresh error: ${err instanceof Error ? err.message : String(err)}`);
			return { entry: undefined, error: message };
		} finally {
			pendingEntryRefreshes.delete(pendingKey);
		}
	})();

	pendingEntryRefreshes.set(pendingKey, refreshPromise);
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

export function hasXarrayEntryDetails(
	notebookUri: vscode.Uri,
	variableName: string
): boolean {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const entry = getCachedXarrayEntry(notebookUri, variableName);
	if (!entry || entry.type !== 'DataArray') {
		return false;
	}
	const meta = xarrayCacheMeta.get(cacheKey)?.get(variableName);
	if (meta) {
		return meta.hasDetails;
	}
	return isDataArrayEntry(entry);
}

export function isXarrayEntryStale(
	notebookUri: vscode.Uri,
	variableName: string,
	maxAgeMs: number = ENTRY_STALE_MS
): boolean {
	const cacheKey = getNotebookCacheKey(notebookUri);
	const meta = xarrayCacheMeta.get(cacheKey)?.get(variableName);
	if (!meta) {
		return true;
	}
	return Date.now() - meta.updatedAt > maxAgeMs;
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
	if (!notebookCache) {
		return [];
	}
	if (!listCacheState.has(cacheKey)) {
		return [];
	}
	return Array.from(notebookCache.values());
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
	xarrayCacheMeta.get(cacheKey)?.delete(variableName);
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

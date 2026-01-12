/**
 * DataArray service for querying DataArray info from the kernel.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../kernel';
import { getNotebookUriForDocument } from '../../notebook';
import { isValidPythonIdentifier } from '../../python/identifiers';
import {
	type DataArrayInfo,
	type DataArrayInfoCacheEntry,
	type DataArrayListEntry,
	DATA_ARRAY_INFO_TTL_MS,
} from './types';
import {
	buildDataArrayInfoCode,
	buildDataArrayListCode,
} from './pythonSnippets';

const dataArrayInfoCache = new Map<string, DataArrayInfoCacheEntry>();

/**
 * Get the cache key for a DataArray info entry.
 */
function getDataArrayInfoCacheKey(notebookUri: vscode.Uri, variableName: string): string {
	return `${notebookUri.toString()}::${variableName}`;
}

/**
 * Get DataArray info for a variable in a document.
 * Uses caching with TTL to avoid excessive kernel queries.
 */
export async function getDataArrayInfo(
	document: vscode.TextDocument,
	variableName: string
): Promise<DataArrayInfo | undefined> {
	const notebookUri = getNotebookUriForDocument(document);
	if (!notebookUri) {
		return;
	}

	const cacheKey = getDataArrayInfoCacheKey(notebookUri, variableName);
	const cached = dataArrayInfoCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < DATA_ARRAY_INFO_TTL_MS) {
		return cached.value;
	}

	try {
		const output = await executeInKernelForOutput(
			notebookUri,
			buildDataArrayInfoCode(variableName)
		);
		const line = extractLastJsonLine(output);
		if (!line) {
			dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
			return;
		}

		const parsed = JSON.parse(line) as {
			name?: string | null;
			dims?: string[];
			sizes?: Record<string, number>;
			shape?: number[];
			dtype?: string;
			ndim?: number;
			watched?: boolean;
			error?: string;
		} | null;
		if (!parsed || parsed.error || !parsed.dims || !parsed.sizes || !parsed.shape || !parsed.dtype || typeof parsed.ndim !== 'number') {
			dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
			return;
		}

		const info: DataArrayInfo = {
			name: parsed.name ?? undefined,
			dims: parsed.dims,
			sizes: parsed.sizes,
			shape: parsed.shape,
			dtype: parsed.dtype,
			ndim: parsed.ndim,
			watched: parsed.watched ?? false,
		};
		dataArrayInfoCache.set(cacheKey, { value: info, timestamp: Date.now() });
		return info;
	} catch {
		dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
		return;
	}
}

/**
 * Invalidate the DataArray info cache for a specific variable.
 */
export function invalidateDataArrayInfoCache(document: vscode.TextDocument, variableName: string): void {
	const notebookUri = getNotebookUriForDocument(document);
	if (!notebookUri) {
		return;
	}
	dataArrayInfoCache.delete(getDataArrayInfoCacheKey(notebookUri, variableName));
}

/**
 * List all DataArrays in the kernel namespace for a notebook.
 */
export async function listDataArrays(
	notebookUri: vscode.Uri
): Promise<{ entries: DataArrayListEntry[]; error?: string }> {
	try {
		const output = await executeInKernelForOutput(notebookUri, buildDataArrayListCode());
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
			.filter((entry) => entry && entry.variableName && entry.dims && entry.sizes && entry.shape && entry.dtype && typeof entry.ndim === 'number')
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
	} catch {
		return { entries: [], error: 'Failed to query the kernel. Ensure the Jupyter kernel is running.' };
	}
}

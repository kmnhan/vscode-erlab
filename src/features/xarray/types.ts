/**
 * xarray object types and constants.
 */

/**
 * The type of xarray object: DataArray, Dataset, or DataTree.
 */
export type XarrayObjectType = 'DataArray' | 'Dataset' | 'DataTree';

/**
 * Represents an xarray object entry with metadata.
 * Used for both individual queries and list results.
 *
 * - DataArray: has all fields including dims, sizes, shape, dtype, ndim, watched
 * - Dataset/DataTree: only have variableName, name, type (no dims/shape/dtype/ndim/watched)
 */
export type XarrayEntry = {
	variableName: string;
	type: XarrayObjectType;
	name?: string;
	// DataArray-specific fields (optional for Dataset/DataTree)
	dims?: string[];
	sizes?: Record<string, number>;
	shape?: number[];
	dtype?: string;
	ndim?: number;
	watched?: boolean;
};

/**
 * Type guard for checking if an entry is a DataArray with full metadata.
 */
export function isDataArrayEntry(entry: XarrayEntry): entry is XarrayEntry & {
	dims: string[];
	sizes: Record<string, number>;
	shape: number[];
	dtype: string;
	ndim: number;
	watched: boolean;
} {
	return entry.type === 'DataArray' &&
		Array.isArray(entry.dims) &&
		typeof entry.sizes === 'object' &&
		Array.isArray(entry.shape) &&
		typeof entry.dtype === 'string' &&
		typeof entry.ndim === 'number';
}

export const DATA_ARRAY_CONTEXT = 'erlab.isDataArray';
export const DATA_ARRAY_WATCHED_CONTEXT = 'erlab.isDataArrayWatched';

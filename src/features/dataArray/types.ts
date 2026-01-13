/**
 * DataArray types and constants.
 */

/**
 * Represents a DataArray entry with all metadata.
 * Used for both individual queries and list results.
 */
export type DataArrayEntry = {
	variableName: string;
	name?: string;
	dims: string[];
	sizes: Record<string, number>;
	shape: number[];
	dtype: string;
	ndim: number;
	watched: boolean;
};

export const DATA_ARRAY_CONTEXT = 'erlab.isDataArray';
export const DATA_ARRAY_WATCHED_CONTEXT = 'erlab.isDataArrayWatched';

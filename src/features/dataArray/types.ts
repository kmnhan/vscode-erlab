/**
 * DataArray types and constants.
 */

export type DataArrayInfo = {
	name?: string;
	dims: string[];
	sizes: Record<string, number>;
	shape: number[];
	dtype: string;
	ndim: number;
	watched?: boolean;
};

export type DataArrayInfoCacheEntry = { value?: DataArrayInfo; timestamp: number };

export type DataArrayListEntry = DataArrayInfo & {
	variableName: string;
};

export const DATA_ARRAY_INFO_TTL_MS = 3000;
export const DATA_ARRAY_CONTEXT = 'erlab.isDataArray';
export const DATA_ARRAY_WATCHED_CONTEXT = 'erlab.isDataArrayWatched';

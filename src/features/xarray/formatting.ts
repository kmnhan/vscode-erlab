/**
 * xarray object formatting utilities for labels and descriptions.
 */
import type { XarrayEntry } from './types';

/**
 * Format an xarray object label with type and dims/sizes for DataArrays.
 */
export function formatXarrayLabel(info: XarrayEntry, fallbackName: string): string {
	const name = info.name ?? fallbackName;

	if (info.type === 'DataArray' && info.dims && info.sizes) {
		const dims = formatDimsWithSizes(info.dims, info.sizes);
		if (!dims) {
			return name;
		}
		return `${name} (${dims})`;
	}

	// Dataset and DataTree: just the name
	return name;
}

/**
 * @deprecated Use formatXarrayLabel instead
 */
export const formatDataArrayLabel = formatXarrayLabel;

/**
 * Format dims with their sizes.
 */
export function formatDimsWithSizes(dims: string[], sizes: Record<string, number>): string {
	if (dims.length === 0) {
		return '';
	}
	return dims
		.map((dim) => `${dim}: ${sizes[dim] ?? '?'}`)
		.join(', ');
}

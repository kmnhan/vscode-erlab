/**
 * DataArray formatting utilities for labels and descriptions.
 */
import type { DataArrayEntry } from './types';

/**
 * Format a DataArray label with dims and sizes.
 */
export function formatDataArrayLabel(info: DataArrayEntry, fallbackName: string): string {
	const name = info.name ?? fallbackName;
	const dims = formatDimsWithSizes(info.dims, info.sizes);
	if (!dims) {
		return name;
	}
	return `${name} (${dims})`;
}

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

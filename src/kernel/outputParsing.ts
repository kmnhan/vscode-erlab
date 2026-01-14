/**
 * Kernel output parsing utilities that are safe to use in unit tests.
 */
import { TextDecoder } from 'util';
import type { KernelOutputItem } from './types';

const textDecoder = new TextDecoder();

/**
 * Decode kernel output item data to a string.
 */
export function decodeKernelOutputItem(item: KernelOutputItem): string | undefined {
	if (item.data instanceof Uint8Array) {
		return textDecoder.decode(item.data);
	}
	if (item.data instanceof ArrayBuffer) {
		return textDecoder.decode(new Uint8Array(item.data));
	}
	if (ArrayBuffer.isView(item.data)) {
		const view = item.data;
		return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (typeof item.data === 'string') {
		return item.data;
	}
	try {
		return JSON.stringify(item.data);
	} catch {
		return;
	}
}

/**
 * Extract the last JSON line from kernel output.
 */
export function extractLastJsonLine(output: string): string | undefined {
	const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (line.startsWith('{') || line.startsWith('[') || line === 'null') {
			return line;
		}
	}
	return;
}

/**
 * Normalize kernel error messages for display.
 */
export function normalizeKernelError(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { name?: string; message?: string; stack?: string };
		if (parsed?.message) {
			return parsed.name ? `${parsed.name}: ${parsed.message}` : parsed.message;
		}
	} catch {
		// Fall back to raw.
	}
	return raw;
}

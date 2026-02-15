/**
 * Kernel output parsing utilities that are safe to use in unit tests.
 */
import { TextDecoder } from 'util';
import type { KernelOutputItem, KernelProvider } from './types';

const textDecoder = new TextDecoder();
const DEFAULT_ENVELOPE_ERROR_MESSAGE = 'Kernel command failed.';
const MAX_ERROR_SUMMARY_LENGTH = 400;

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function htmlToPlainText(value: string): string {
	const withLineBreaks = value
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/p>/gi, '\n')
		.replace(/<\/div>/gi, '\n');
	const withoutTags = withLineBreaks.replace(/<[^>]+>/g, '');
	return decodeHtmlEntities(withoutTags).trim();
}

function truncateErrorSummary(value: string): string {
	const normalized = value.replace(/\r/g, '').trim();
	if (normalized.length > MAX_ERROR_SUMMARY_LENGTH) {
		return `${normalized.slice(0, MAX_ERROR_SUMMARY_LENGTH)}...`;
	}
	return normalized;
}

function normalizeProviderFallbackError(value: string): string {
	return truncateErrorSummary(normalizeKernelError(value));
}

function dedupeAndJoinErrors(errors: string[]): string | undefined {
	const cleaned = Array.from(new Set(errors.map((entry) => entry.trim()).filter(Boolean)));
	if (cleaned.length === 0) {
		return;
	}
	return cleaned.join('; ');
}

export type KernelCommandEnvelopeResult = {
	ok?: boolean;
	exc_type?: string;
	message?: string;
	traceback?: string;
};

export function buildKernelCommandEnvelope(code: string, marker: string): string {
	const safeCode = code.trim().length > 0 ? code : 'pass';
	return [
		'import json as __erlab_tmp__json',
		'import sys as __erlab_tmp__sys',
		'import traceback as __erlab_tmp__traceback',
		`__erlab_tmp__code = ${JSON.stringify(safeCode)}`,
		'try:',
		'    exec(compile(__erlab_tmp__code, "<erlab>", "exec"), globals(), globals())',
		`    __erlab_tmp__sys.stdout.write(${JSON.stringify(marker)} + __erlab_tmp__json.dumps({"ok": True}) + "\\n")`,
		'    __erlab_tmp__sys.stdout.flush()',
		'except BaseException as __erlab_tmp__exc:',
		`    __erlab_tmp__sys.stdout.write(${JSON.stringify(marker)} + __erlab_tmp__json.dumps({`,
		'        "ok": False,',
		'        "exc_type": type(__erlab_tmp__exc).__name__,',
		'        "message": str(__erlab_tmp__exc),',
		'        "traceback": __erlab_tmp__traceback.format_exc(),',
		'    }) + "\\n")',
		'    __erlab_tmp__sys.stdout.flush()',
	].join('\n');
}

export function extractKernelCommandEnvelopeResult(
	output: string,
	marker: string
): { cleanedOutput: string; result?: KernelCommandEnvelopeResult } {
	const lines = output.split(/\r?\n/);
	const kept: string[] = [];
	let result: KernelCommandEnvelopeResult | undefined;

	for (const line of lines) {
		if (!line.startsWith(marker)) {
			kept.push(line);
			continue;
		}
		const payload = line.slice(marker.length).trim();
		try {
			const parsed = JSON.parse(payload) as KernelCommandEnvelopeResult;
			if (parsed && typeof parsed === 'object') {
				result = parsed;
				continue;
			}
		} catch {
			// Keep malformed lines in visible output.
		}
		kept.push(line);
	}

	return {
		cleanedOutput: kept.join('\n'),
		result,
	};
}

export function summarizeKernelCommandEnvelopeError(result: KernelCommandEnvelopeResult): {
	summary: string;
	traceback?: string;
} {
	const excType = typeof result.exc_type === 'string' && result.exc_type.trim()
		? result.exc_type.trim()
		: 'Error';
	const message = typeof result.message === 'string' && result.message.trim()
		? result.message.trim()
		: DEFAULT_ENVELOPE_ERROR_MESSAGE;
	const summary = message.startsWith(`${excType}:`) ? message : `${excType}: ${message}`;
	return {
		summary: truncateErrorSummary(summary),
		traceback: typeof result.traceback === 'string' && result.traceback.trim()
			? result.traceback.trim()
			: undefined,
	};
}

/**
 * Select the single error shown to users from all possible sources.
 * Preference order:
 * 1) structured envelope errors (deterministic and concise),
 * 2) provider transport errors (fallback when no envelope result exists).
 */
export function selectKernelExecutionError(params: {
	transportErrors: string[];
	envelopeResult?: KernelCommandEnvelopeResult;
}): { message?: string; traceback?: string; source?: 'envelope' | 'transport' } {
	const { transportErrors, envelopeResult } = params;

	if (envelopeResult?.ok === false) {
		const { summary, traceback } = summarizeKernelCommandEnvelopeError(envelopeResult);
		return { message: summary, traceback, source: 'envelope' };
	}

	if (envelopeResult?.ok === true) {
		return {};
	}

	const transportMessage = dedupeAndJoinErrors(transportErrors);
	if (!transportMessage) {
		return {};
	}
	return {
		message: transportMessage,
		source: 'transport',
	};
}

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
		const parsed = JSON.parse(raw) as { name?: string; message?: string };
		if (parsed?.message) {
			return parsed.name ? `${parsed.name}: ${parsed.message}` : parsed.message;
		}
	} catch {
		// Fall back to raw.
	}
	return raw;
}

export function classifyKernelErrorOutput(params: {
	provider: KernelProvider;
	outputChannel?: string;
	item: KernelOutputItem;
	errorMime: string;
	stderrMime: string;
}): string | undefined {
	const {
		provider,
		outputChannel,
		item,
		errorMime,
		stderrMime,
	} = params;
	const decoded = decodeKernelOutputItem(item)?.trim();
	if (!decoded) {
		return;
	}

	if (item.mime === errorMime) {
		return normalizeProviderFallbackError(decoded);
	}

	if (provider !== 'marimo') {
		return;
	}

	// marimo may emit failures through both channel metadata and traceback html.
	// Keep this strictly as fallback for cases where envelope output is unavailable.
	if (outputChannel === 'marimo-error') {
		const raw = item.mime === 'text/html' ? htmlToPlainText(decoded) : decoded;
		return normalizeProviderFallbackError(raw);
	}

	if (outputChannel === 'stderr' && item.mime === stderrMime) {
		return normalizeProviderFallbackError(decoded);
	}

	return;
}

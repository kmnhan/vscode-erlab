/**
 * Kernel execution utilities for interacting with Jupyter kernels.
 */
import * as vscode from 'vscode';
import { TextDecoder } from 'util';
import type { JupyterApi, KernelOutputItem } from './types';
import { logger } from '../logger';

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

/**
 * Get the Jupyter API from the ms-toolsai.jupyter extension.
 */
async function getJupyterApi(): Promise<JupyterApi | undefined> {
	const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
	if (!jupyterExtension) {
		return undefined;
	}
	const activatedApi = await jupyterExtension.activate() as JupyterApi | undefined;
	return (jupyterExtension.exports ?? activatedApi) as JupyterApi | undefined;
}

/**
 * Execute code in the Jupyter kernel (with user-facing messages on errors).
 * Returns stdout output as a string.
 */
export async function executeInKernel(notebookUri: vscode.Uri | undefined, code: string): Promise<string> {
	if (!notebookUri) {
		vscode.window.showInformationMessage('erlab: open a notebook to run the magic.');
		return '';
	}

	const jupyterApi = await getJupyterApi();
	if (!jupyterApi) {
		vscode.window.showInformationMessage('erlab: Jupyter extension not found.');
		return '';
	}
	if (!jupyterApi.kernels || typeof jupyterApi.kernels.getKernel !== 'function') {
		vscode.window.showInformationMessage('erlab: Jupyter kernel API not available.');
		return '';
	}

	const kernel = await jupyterApi.kernels.getKernel(notebookUri);
	if (!kernel || typeof kernel.executeCode !== 'function') {
		vscode.window.showInformationMessage('erlab: no active kernel for this notebook.');
		return '';
	}

	logger.debug(`Executing code in kernel for ${notebookUri?.fsPath ?? 'unknown'}`);
	logger.trace(`Python code to execute:\n${code}`);

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stdoutMime = vscode.NotebookCellOutputItem.stdout('').mime;
	const textPlainMime = 'text/plain';
	const chunks: string[] = [];
	const errors: string[] = [];
	let iterationCount = 0;
	try {
		logger.trace('Starting kernel execution loop...');
		for await (const output of kernel.executeCode(code, tokenSource.token)) {
			iterationCount++;
			logger.trace('Kernel output iteration {0}: received {1} items', iterationCount, output.items.length);
			for (const item of output.items) {
				if (item.mime === errorMime) {
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
				}
			}
		}
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations`);
	} finally {
		tokenSource.dispose();
	}

	if (errors.length > 0) {
		const errorMessage = errors.map((err) => err.trim()).filter(Boolean).join('; ');
		logger.error(`Kernel execution failed: ${errorMessage}`);
		throw new Error(errorMessage);
	}

	logger.debug(`Kernel execution completed, received ${chunks.length} output chunks`);
	return chunks.join('');
}

/**
 * Execute code in the Jupyter kernel for output retrieval (throws on error).
 * Returns all output including non-stdout mime types.
 */
export async function executeInKernelForOutput(
	notebookUri: vscode.Uri,
	code: string
): Promise<string> {
	const jupyterApi = await getJupyterApi();
	if (!jupyterApi) {
		throw new Error('Jupyter extension not found.');
	}
	if (!jupyterApi.kernels || typeof jupyterApi.kernels.getKernel !== 'function') {
		throw new Error('Jupyter kernel API not available.');
	}

	const kernel = await jupyterApi.kernels.getKernel(notebookUri);
	if (!kernel || typeof kernel.executeCode !== 'function') {
		throw new Error('No active kernel for this notebook.');
	}

	logger.debug(`Executing code for output in kernel for ${notebookUri.fsPath}`);
	logger.trace(`Python code to execute:\n${code}`);

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stdoutMime = vscode.NotebookCellOutputItem.stdout('').mime;
	const textPlainMime = 'text/plain';
	const chunks: string[] = [];
	const errors: string[] = [];
	let iterationCount = 0;
	try {
		logger.trace('Starting kernel execution loop...');
		for await (const output of kernel.executeCode(code, tokenSource.token)) {
			iterationCount++;
			logger.trace(`Kernel output iteration ${iterationCount}: received ${output.items.length} items`);
			for (const item of output.items) {
				if (item.mime === errorMime) {
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
				} else {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
				}
			}
		}
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations`);
	} finally {
		tokenSource.dispose();
	}

	if (errors.length > 0) {
		const errorMessage = errors.map((err) => err.trim()).filter(Boolean).join('; ');
		logger.error(`Kernel execution for output failed: ${errorMessage}`);
		throw new Error(errorMessage);
	}

	logger.debug(`Kernel execution for output completed, received ${chunks.length} chunks`);
	return chunks.join('');
}

/**
 * Kernel execution utilities for interacting with Jupyter kernels.
 */
import * as vscode from 'vscode';
import type { JupyterApi, KernelLike, KernelOutputItem } from './types';
import { logger } from '../logger';
import {
	decodeKernelOutputItem,
	normalizeKernelError,
} from './outputParsing';

const DEFAULT_KERNEL_TIMEOUT_MS = 10000;
const DEFAULT_KERNEL_WARN_MS = 2000;
const DEFAULT_KERNEL_QUEUE_WARN_MS = 2000;

export type KernelExecutionOptions = {
	timeoutMs?: number;
	warnAfterMs?: number;
	queueTimeoutMs?: number;
	operation?: string;
	interruptOnTimeout?: boolean;
};

function formatOperationLabel(operation?: string): string {
	return operation ? ` (${operation})` : '';
}

function createKernelExecutionTimeout(
	options: KernelExecutionOptions | undefined,
	label: string,
	onTimeout: () => void
): {
	timeoutPromise?: Promise<never>;
	getElapsedMs: () => number;
	start: () => void;
	onOutput: () => void;
	dispose: () => void;
	didTimeout: () => boolean;
	warnAfterMs: number;
} {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
	const warnAfterMs = options?.warnAfterMs ?? DEFAULT_KERNEL_WARN_MS;
	let startTime: number | undefined;
	let timeoutHandle: NodeJS.Timeout | undefined;
	let queueWarnHandle: NodeJS.Timeout | undefined;
	let didTimeoutFlag = false;
	let rejectRef: ((reason?: Error) => void) | undefined;

	const stopTimer = () => {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
		}
	};

	const triggerTimeout = (reject: (reason?: Error) => void) => {
		didTimeoutFlag = true;
		stopTimer();
		logger.warn(`Kernel execution timed out${label} after ${timeoutMs}ms.`);
		onTimeout();
		reject(new Error(`Kernel execution timed out after ${timeoutMs}ms.`));
	};

	const startTimer = () => {
		const reject = rejectRef;
		if (!reject || timeoutMs <= 0 || startTime !== undefined) {
			return;
		}
		startTime = Date.now();
		timeoutHandle = setTimeout(() => triggerTimeout(reject), timeoutMs);
	};

	const timeoutPromise = timeoutMs > 0
		? new Promise<never>((_resolve, reject) => {
			rejectRef = reject;
			queueWarnHandle = setTimeout(() => {
				logger.warn(`Kernel output delayed${label}.`);
			}, DEFAULT_KERNEL_QUEUE_WARN_MS);
		})
		: undefined;

	const getElapsedMs = () => {
		return startTime ? Date.now() - startTime : 0;
	};

	const onOutput = () => {
		if (queueWarnHandle) {
			clearTimeout(queueWarnHandle);
			queueWarnHandle = undefined;
		}
	};

	const dispose = () => {
		stopTimer();
		if (queueWarnHandle) {
			clearTimeout(queueWarnHandle);
			queueWarnHandle = undefined;
		}
	};

	return {
		timeoutPromise,
		getElapsedMs,
		start: startTimer,
		onOutput,
		dispose,
		didTimeout: () => didTimeoutFlag,
		warnAfterMs,
	};
}

async function tryInterruptKernel(
	_kernel: KernelLike,
	notebookUri: vscode.Uri,
	operation?: string
): Promise<void> {
	const label = formatOperationLabel(operation);
	try {
		await vscode.commands.executeCommand('jupyter.interruptkernel', notebookUri);
		logger.warn(`Interrupted kernel via command${label}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/command .*not found/i.test(message)) {
			logger.warn(`Kernel interrupt command not available${label}.`);
			return;
		}
		logger.warn(`Kernel command interrupt failed${label}: ${message}`);
	}
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
 * Get the active kernel for a notebook, if available.
 */
export async function getKernelForNotebook(
	notebookUri: vscode.Uri
): Promise<KernelLike | undefined> {
	const jupyterApi = await getJupyterApi();
	if (!jupyterApi?.kernels || typeof jupyterApi.kernels.getKernel !== 'function') {
		return;
	}
	const kernel = await jupyterApi.kernels.getKernel(notebookUri);
	if (!kernel || typeof kernel.executeCode !== 'function') {
		return;
	}
	return kernel;
}

/**
 * Execute code in the Jupyter kernel (with user-facing messages on errors).
 * Returns stdout output as a string.
 */
export async function executeInKernel(
	notebookUri: vscode.Uri | undefined,
	code: string,
	options?: KernelExecutionOptions
): Promise<string> {
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
	const label = formatOperationLabel(options?.operation);
	const iterator = kernel.executeCode(code, tokenSource.token)[Symbol.asyncIterator]();
	const outputMimes = new Set([stdoutMime, textPlainMime]);
	const handleDecodedOutput = (item: KernelOutputItem) => {
		if (!outputMimes.has(item.mime)) {
			return;
		}
		const decoded = decodeKernelOutputItem(item);
		if (decoded) {
			chunks.push(decoded);
		}
	};
	const executionPromise = (async () => {
		logger.trace('Starting kernel execution loop...');
		for (; ;) {
			const { value, done } = await iterator.next();
			if (done || !value) {
				break;
			}
			iterationCount++;
			logger.trace('Kernel output iteration {0}: received {1} items', iterationCount, value.items.length);
			for (const item of value.items) {
				if (item.mime === errorMime) {
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else {
					handleDecodedOutput(item);
				}
			}
		}
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations`);

		if (errors.length > 0) {
			const errorMessage = errors.map((err) => err.trim()).filter(Boolean).join('; ');
			logger.error(`Kernel execution failed${label}: ${errorMessage}`);
			throw new Error(errorMessage);
		}

		logger.debug(`Kernel execution completed${label}, received ${chunks.length} output chunks`);
		return chunks.join('');
	})();

	try {
		const result = await executionPromise;
		return result;
	} finally {
		tokenSource.dispose();
	}
}

/**
 * Execute code in the Jupyter kernel for output retrieval (throws on error).
 * Returns all output including non-stdout mime types.
 */
export async function executeInKernelForOutput(
	notebookUri: vscode.Uri,
	code: string,
	options?: KernelExecutionOptions
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

	const executionMarker = `__erlab_exec_start_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const codeWithMarker = `print(${JSON.stringify(executionMarker)}, flush=True)\n${code}`;

	logger.debug(`Executing code for output in kernel for ${notebookUri.fsPath}`);
	logger.trace(`Python code to execute:\n${codeWithMarker}`);

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const chunks: string[] = [];
	const errors: string[] = [];
	let iterationCount = 0;
	let markerSeen = false;
	const label = formatOperationLabel(options?.operation);
	const warnAfterMs = options?.warnAfterMs ?? DEFAULT_KERNEL_WARN_MS;
	const interruptOnTimeout = options?.interruptOnTimeout ?? true;
	const queueTimeoutMs = options?.queueTimeoutMs ?? options?.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;

	const iterator = kernel.executeCode(codeWithMarker, tokenSource.token)[Symbol.asyncIterator]();
	const timeoutController = createKernelExecutionTimeout(options, label, () => {
		tokenSource.cancel();
		void iterator.return?.();
		if (interruptOnTimeout) {
			void tryInterruptKernel(kernel, notebookUri, options?.operation);
		}
	});
	const handleDecodedOutput = (decoded?: string) => {
		if (!decoded) {
			return;
		}
		if (!markerSeen && decoded.includes(executionMarker)) {
			markerSeen = true;
			if (queueTimeoutHandle) {
				clearTimeout(queueTimeoutHandle);
				queueTimeoutHandle = undefined;
			}
			timeoutController.start();
		}
		chunks.push(decoded);
	};
	let queueTimedOut = false;
	let queueTimeoutHandle: NodeJS.Timeout | undefined;
	const queueTimeoutPromise = queueTimeoutMs > 0
		? new Promise<never>((_resolve, reject) => {
			queueTimeoutHandle = setTimeout(() => {
				if (markerSeen) {
					return;
				}
				queueTimedOut = true;
				logger.warn(`Kernel execution did not start${label} after ${queueTimeoutMs}ms.`);
				tokenSource.cancel();
				void iterator.return?.();
				reject(new Error(`Kernel execution did not start within ${queueTimeoutMs}ms.`));
			}, queueTimeoutMs);
		})
		: undefined;
	const executionPromise = (async () => {
		logger.trace('Starting kernel execution loop...');
		for (; ;) {
			const { value, done } = await iterator.next();
			if (done || !value) {
				break;
			}
			iterationCount++;
			timeoutController.onOutput();
			logger.trace(`Kernel output iteration ${iterationCount}: received ${value.items.length} items`);
			for (const item of value.items) {
				if (item.mime === errorMime) {
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else {
					handleDecodedOutput(decodeKernelOutputItem(item));
				}
			}
		}
		const loopElapsedMs = timeoutController.getElapsedMs();
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations in ${loopElapsedMs}ms`);

		if (errors.length > 0) {
			const errorMessage = errors.map((err) => err.trim()).filter(Boolean).join('; ');
			logger.error(`Kernel execution for output failed${label}: ${errorMessage}`);
			throw new Error(errorMessage);
		}

		logger.debug(`Kernel execution for output completed${label}, received ${chunks.length} chunks`);
		const output = chunks.join('');
		const cleaned = output
			.split(/\r?\n/)
			.filter((line) => line !== executionMarker)
			.join('\n');
		return cleaned;
	})();

	try {
		const racePromises = [executionPromise];
		if (timeoutController.timeoutPromise) {
			racePromises.push(timeoutController.timeoutPromise);
		}
		if (queueTimeoutPromise) {
			racePromises.push(queueTimeoutPromise);
		}
		const result = racePromises.length > 1
			? await Promise.race(racePromises)
			: await executionPromise;
		const elapsedMs = timeoutController.getElapsedMs();
		if (warnAfterMs > 0 && elapsedMs > warnAfterMs) {
			logger.warn(`Slow kernel execution${label}: ${elapsedMs}ms`);
		}
		return result;
	} finally {
		timeoutController.dispose();
		if (queueTimeoutHandle) {
			clearTimeout(queueTimeoutHandle);
			queueTimeoutHandle = undefined;
		}
		if (timeoutController.didTimeout() || queueTimedOut) {
			void executionPromise.catch(() => { });
		}
		tokenSource.dispose();
	}
}

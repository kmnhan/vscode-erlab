/**
 * Kernel execution utilities for interacting with notebook kernels.
 */
import * as vscode from 'vscode';
import type {
	JupyterApi,
	KernelAccessor,
	KernelLike,
	KernelOutput,
	KernelOutputItem,
	KernelProvider,
	MarimoApi,
} from './types';
import { logger } from '../logger';
import {
	buildKernelCommandEnvelope,
	classifyKernelErrorOutput,
	decodeKernelOutputItem,
	extractKernelCommandEnvelopeResult,
	selectKernelExecutionError,
} from './outputParsing';

const DEFAULT_KERNEL_TIMEOUT_MS = 10000;
const DEFAULT_KERNEL_WARN_MS = 2000;
const DEFAULT_KERNEL_QUEUE_WARN_MS = 2000;
const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';
const MARIMO_EXTENSION_ID = 'marimo-team.vscode-marimo';

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
} {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;
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
	};
}

type KernelClientAccess = {
	provider: KernelProvider;
	kernel: KernelLike;
};

type KernelResolution = {
	providers: KernelProvider[];
	access?: KernelClientAccess;
};

type KernelOutputCollectionParams = {
	iterator: AsyncIterator<KernelOutput>;
	provider: KernelProvider;
	errorMime: string;
	stderrMime: string;
	onOutputItem: (item: KernelOutputItem) => void;
	onIteration?: () => void;
};

type EnvelopeExecutionResultParams = {
	chunks: string[];
	envelopeMarker: string;
	transportErrors: string[];
	label: string;
	failureLogPrefix: string;
	completionLogPrefix: string;
	logEnvelopeTraceback: boolean;
	stripLine?: string;
};

async function collectKernelOutputItems(params: KernelOutputCollectionParams): Promise<{
	iterationCount: number;
	errors: string[];
}> {
	const {
		iterator,
		provider,
		errorMime,
		stderrMime,
		onOutputItem,
		onIteration,
	} = params;
	const errors: string[] = [];
	let iterationCount = 0;

	for (; ;) {
		const { value, done } = await iterator.next();
		if (done || !value) {
			break;
		}
		iterationCount++;
		onIteration?.();
		logger.trace('Kernel output iteration {0}: received {1} items', iterationCount, value.items.length);
		const outputChannel = typeof value.metadata?.channel === 'string' ? value.metadata.channel : undefined;
		for (const item of value.items) {
			const classifiedError = classifyKernelErrorOutput({
				provider,
				outputChannel,
				item,
				errorMime,
				stderrMime,
			});
			if (classifiedError) {
				errors.push(classifiedError);
				continue;
			}
			onOutputItem(item);
		}
	}

	return { iterationCount, errors };
}

function createExecutionMarker(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function finalizeEnvelopeExecutionResult(params: EnvelopeExecutionResultParams): string {
	const {
		chunks,
		envelopeMarker,
		transportErrors,
		label,
		failureLogPrefix,
		completionLogPrefix,
		logEnvelopeTraceback,
		stripLine,
	} = params;

	const output = chunks.join('');
	const { cleanedOutput, result } = extractKernelCommandEnvelopeResult(output, envelopeMarker);
	const selectedError = selectKernelExecutionError({
		transportErrors,
		envelopeResult: result,
	});
	if (selectedError.message) {
		if (logEnvelopeTraceback && selectedError.source === 'envelope' && selectedError.traceback) {
			logger.error(`${failureLogPrefix}${label}: ${selectedError.message}\n${selectedError.traceback}`);
		} else {
			logger.error(`${failureLogPrefix}${label}: ${selectedError.message}`);
		}
		throw new Error(selectedError.message);
	}

	if (result?.ok === true && transportErrors.length > 0) {
		logger.debug(
			`Ignoring ${transportErrors.length} side-channel kernel error output(s) because envelope reported success${label}.`
		);
	}

	const cleaned = stripLine
		? cleanedOutput
			.split(/\r?\n/)
			.filter((line) => line !== stripLine)
			.join('\n')
		: cleanedOutput;
	logger.debug(`${completionLogPrefix}${label}, received ${chunks.length} output chunks`);
	return cleaned;
}

function isKernelAccessor(value: unknown): value is KernelAccessor {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as { getKernel?: unknown };
	return typeof candidate.getKernel === 'function';
}

function getKernelAccessorForProvider(
	provider: KernelProvider,
	api: JupyterApi | MarimoApi | undefined
): KernelAccessor | undefined {
	if (!api) {
		return;
	}
	if (provider === 'jupyter') {
		return isKernelAccessor((api as JupyterApi).kernels) ? (api as JupyterApi).kernels : undefined;
	}
	const marimo = api as MarimoApi;
	return isKernelAccessor(marimo.experimental?.kernels) ? marimo.experimental.kernels : undefined;
}

async function activateExtensionApi<T>(extensionId: string): Promise<T | undefined> {
	const extension = vscode.extensions.getExtension(extensionId);
	if (!extension) {
		return;
	}
	const activatedApi = await extension.activate() as T | undefined;
	return (extension.exports ?? activatedApi) as T | undefined;
}

/**
 * Get the Jupyter API from the ms-toolsai.jupyter extension.
 */
async function getJupyterApi(): Promise<JupyterApi | undefined> {
	return activateExtensionApi<JupyterApi>(JUPYTER_EXTENSION_ID);
}

/**
 * Get the marimo API from the marimo-team.vscode-marimo extension.
 */
async function getMarimoApi(): Promise<MarimoApi | undefined> {
	return activateExtensionApi<MarimoApi>(MARIMO_EXTENSION_ID);
}

async function resolveKernel(
	notebookUri: vscode.Uri
): Promise<KernelResolution> {
	const providers: KernelProvider[] = [];

	const jupyterAccessor = getKernelAccessorForProvider('jupyter', await getJupyterApi());
	if (jupyterAccessor) {
		providers.push('jupyter');
		try {
			const kernel = await jupyterAccessor.getKernel(notebookUri);
			if (kernel && typeof kernel.executeCode === 'function') {
				return { providers, access: { provider: 'jupyter', kernel } };
			}
		} catch (error) {
			logger.debug(`Jupyter kernel lookup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const marimoAccessor = getKernelAccessorForProvider('marimo', await getMarimoApi());
	if (marimoAccessor) {
		providers.push('marimo');
		try {
			const kernel = await marimoAccessor.getKernel(notebookUri);
			if (kernel && typeof kernel.executeCode === 'function') {
				return { providers, access: { provider: 'marimo', kernel } };
			}
		} catch (error) {
			logger.debug(`marimo kernel lookup failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { providers };
}

async function tryInterruptKernel(
	provider: KernelProvider,
	notebookUri: vscode.Uri,
	operation?: string
): Promise<void> {
	const label = formatOperationLabel(operation);
	switch (provider) {
		case 'jupyter':
			try {
				await vscode.commands.executeCommand('jupyter.interruptkernel', notebookUri);
				logger.warn(`Interrupted ${provider} kernel via command${label}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/command .*not found/i.test(message)) {
					logger.warn(`Kernel interrupt command not available${label}.`);
					return;
				}
				logger.warn(`Kernel command interrupt failed${label}: ${message}`);
			}
			return;
		case 'marimo':
			logger.warn(`Kernel interrupt is not supported for marimo via public API${label}.`);
			return;
		default:
			return;
		}
}

/**
 * Get the active kernel for a notebook, if available.
 */
export async function getKernelForNotebook(
	notebookUri: vscode.Uri
): Promise<KernelLike | undefined> {
	const { access } = await resolveKernel(notebookUri);
	return access?.kernel;
}

/**
 * Execute code in the active notebook kernel (with user-facing messages on errors).
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

	const resolution = await resolveKernel(notebookUri);
	const kernelAccess = resolution.access;
	if (!kernelAccess) {
		if (resolution.providers.length === 0) {
			vscode.window.showInformationMessage(
				'erlab: no compatible notebook extension found. Install Jupyter or marimo.'
			);
			return '';
		}
		vscode.window.showInformationMessage('erlab: no active kernel for this notebook.');
		return '';
	}
	const { provider, kernel } = kernelAccess;
	const envelopeMarker = `${createExecutionMarker('__erlab_exec_result')}:`;
	const codeWithEnvelope = buildKernelCommandEnvelope(code, envelopeMarker);

	logger.debug(`Executing code in ${provider} kernel for ${notebookUri.fsPath ?? 'unknown'}`);
	logger.trace(`Python code to execute:\n${codeWithEnvelope}`);

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stderrMime = vscode.NotebookCellOutputItem.stderr('').mime;
	const stdoutMime = vscode.NotebookCellOutputItem.stdout('').mime;
	const textPlainMime = 'text/plain';
	const chunks: string[] = [];
	const label = formatOperationLabel(options?.operation);
	const iterator = kernel.executeCode(codeWithEnvelope, tokenSource.token)[Symbol.asyncIterator]();
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
		const { iterationCount, errors } = await collectKernelOutputItems({
			iterator,
			provider,
			errorMime,
			stderrMime,
			onOutputItem: handleDecodedOutput,
		});
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations`);
		return finalizeEnvelopeExecutionResult({
			chunks,
			envelopeMarker,
			transportErrors: errors,
			label,
			failureLogPrefix: 'Kernel execution failed',
			completionLogPrefix: 'Kernel execution completed',
			logEnvelopeTraceback: true,
		});
	})();

	try {
		const result = await executionPromise;
		return result;
	} finally {
		tokenSource.dispose();
	}
}

/**
 * Execute code in the active notebook kernel for output retrieval (throws on error).
 * Returns all output including non-stdout mime types.
 */
export async function executeInKernelForOutput(
	notebookUri: vscode.Uri,
	code: string,
	options?: KernelExecutionOptions
): Promise<string> {
	const resolution = await resolveKernel(notebookUri);
	const kernelAccess = resolution.access;
	if (!kernelAccess) {
		if (resolution.providers.length === 0) {
			throw new Error('No compatible notebook extension found. Install Jupyter or marimo.');
		}
		throw new Error('No active kernel for this notebook.');
	}
	const { provider, kernel } = kernelAccess;

	const executionMarker = createExecutionMarker('__erlab_exec_start');
	const envelopeMarker = `${createExecutionMarker('__erlab_exec_result')}:`;
	const codeWithEnvelope = buildKernelCommandEnvelope(
		`print(${JSON.stringify(executionMarker)}, flush=True)\n${code}`,
		envelopeMarker
	);

	logger.debug(`Executing code for output in ${provider} kernel for ${notebookUri.fsPath}`);
	logger.trace(`Python code to execute:\n${codeWithEnvelope}`);

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stderrMime = vscode.NotebookCellOutputItem.stderr('').mime;
	const chunks: string[] = [];
	let markerSeen = false;
	const label = formatOperationLabel(options?.operation);
	const warnAfterMs = options?.warnAfterMs ?? DEFAULT_KERNEL_WARN_MS;
	const interruptOnTimeout = options?.interruptOnTimeout ?? true;
	const queueTimeoutMs = options?.queueTimeoutMs ?? options?.timeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS;

	const iterator = kernel.executeCode(codeWithEnvelope, tokenSource.token)[Symbol.asyncIterator]();
	const timeoutController = createKernelExecutionTimeout(options, label, () => {
		tokenSource.cancel();
		void iterator.return?.();
		if (interruptOnTimeout) {
			void tryInterruptKernel(provider, notebookUri, options?.operation);
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
		const { iterationCount, errors } = await collectKernelOutputItems({
			iterator,
			provider,
			errorMime,
			stderrMime,
			onIteration: () => timeoutController.onOutput(),
			onOutputItem: (item) => handleDecodedOutput(decodeKernelOutputItem(item)),
		});
		const loopElapsedMs = timeoutController.getElapsedMs();
		logger.trace(`Kernel execution loop completed after ${iterationCount} iterations in ${loopElapsedMs}ms`);
		return finalizeEnvelopeExecutionResult({
			chunks,
			envelopeMarker,
			transportErrors: errors,
			label,
			failureLogPrefix: 'Kernel execution for output failed',
			completionLogPrefix: 'Kernel execution for output completed',
			logEnvelopeTraceback: false,
			stripLine: executionMarker,
		});
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

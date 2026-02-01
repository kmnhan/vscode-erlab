/**
 * Mock utilities for kernel-dependent unit tests.
 *
 * These mocks allow testing kernel-dependent code without requiring
 * a real Jupyter kernel, avoiding the asynchronous kernel discovery
 * race conditions that plague real kernel tests.
 *
 * NOTE: These mocks are VS Code-independent to allow use in pure unit tests.
 * For VS Code integration tests, use these with actual vscode types.
 */
import type { KernelLike, KernelOutput, JupyterApi } from '../../kernel/types';

/**
 * Minimal cancellation token interface for mocking (VS Code-independent).
 */
export interface CancellationTokenLike {
	isCancellationRequested: boolean;
}

/**
 * Minimal URI interface for mocking (VS Code-independent).
 */
export interface UriLike {
	toString(): string;
}

/**
 * Create a mock kernel that returns predefined responses for code execution.
 *
 * @param responses - A map of code strings to their expected output responses.
 *                    If code is not found in the map, returns empty output.
 */
export function createMockKernel(responses: Map<string, string>): KernelLike {
	return {
		executeCode: (code: string, _token: CancellationTokenLike): AsyncIterable<KernelOutput> => {
			const output = responses.get(code) ?? '';
			return {
				[Symbol.asyncIterator]: async function* () {
					yield {
						items: [{
							mime: 'text/plain',
							data: new TextEncoder().encode(output),
						}],
					};
				},
			};
		},
	} as KernelLike;
}

/**
 * Create a mock kernel that returns a single response for any code execution.
 *
 * @param response - The output to return for any code execution.
 */
export function createMockKernelWithResponse(response: string): KernelLike {
	return {
		executeCode: (_code: string, _token: CancellationTokenLike): AsyncIterable<KernelOutput> => {
			return {
				[Symbol.asyncIterator]: async function* () {
					yield {
						items: [{
							mime: 'text/plain',
							data: new TextEncoder().encode(response),
						}],
					};
				},
			};
		},
	} as KernelLike;
}

/**
 * Create a mock kernel that throws an error on code execution.
 *
 * @param errorMessage - The error message to throw.
 */
export function createMockKernelWithError(errorMessage: string): KernelLike {
	return {
		executeCode: (_code: string, _token: CancellationTokenLike): AsyncIterable<KernelOutput> => {
			return {
				[Symbol.asyncIterator]: async function* () {
					throw new Error(errorMessage);
				},
			};
		},
	} as KernelLike;
}

/**
 * Create a mock kernel that yields multiple outputs in sequence.
 *
 * @param outputs - Array of output strings to yield in order.
 */
export function createMockKernelWithMultipleOutputs(outputs: string[]): KernelLike {
	return {
		executeCode: (_code: string, _token: CancellationTokenLike): AsyncIterable<KernelOutput> => {
			return {
				[Symbol.asyncIterator]: async function* () {
					for (const output of outputs) {
						yield {
							items: [{
								mime: 'text/plain',
								data: new TextEncoder().encode(output),
							}],
						};
					}
				},
			};
		},
	} as KernelLike;
}

/**
 * Create a mock kernel that respects cancellation.
 *
 * @param response - The output to return if not cancelled.
 * @param delayMs - Delay before yielding output (to allow cancellation).
 */
export function createMockKernelWithCancellation(response: string, delayMs: number = 100): KernelLike {
	return {
		executeCode: (_code: string, token: CancellationTokenLike): AsyncIterable<KernelOutput> => {
			return {
				[Symbol.asyncIterator]: async function* () {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					if (token.isCancellationRequested) {
						return;
					}
					yield {
						items: [{
							mime: 'text/plain',
							data: new TextEncoder().encode(response),
						}],
					};
				},
			};
		},
	} as KernelLike;
}

/**
 * Create a mock Jupyter API that returns the given kernel for any URI.
 *
 * @param kernel - The mock kernel to return.
 */
export function createMockJupyterApi(kernel: KernelLike): JupyterApi {
	return {
		kernels: {
			getKernel: async () => kernel,
		},
	};
}

/**
 * Create a mock Jupyter API that returns undefined (no kernel available).
 */
export function createMockJupyterApiNoKernel(): JupyterApi {
	return {
		kernels: {
			getKernel: async () => undefined,
		},
	};
}

/**
 * Create a mock Jupyter API that returns different kernels for different URIs.
 *
 * @param kernelMap - A map of URI strings to their respective mock kernels.
 */
export function createMockJupyterApiWithMapping(kernelMap: Map<string, KernelLike>): JupyterApi {
	return {
		kernels: {
			getKernel: async (uri: UriLike) => kernelMap.get(uri.toString()),
		},
	};
}

/**
 * Helper to create a standard xarray query response JSON.
 *
 * @param entries - Array of xarray entry data.
 */
export function createXarrayQueryResponse(entries: Array<{
	variableName: string;
	type: 'DataArray' | 'Dataset' | 'DataTree';
	name?: string | null;
	dims?: string[];
	sizes?: Record<string, number>;
	shape?: number[];
	dtype?: string;
	ndim?: number;
	watched?: boolean;
}>): string {
	return JSON.stringify(entries);
}

/**
 * Helper to create an error response JSON.
 *
 * @param errorMessage - The error message.
 */
export function createErrorResponse(errorMessage: string): string {
	return JSON.stringify({ error: errorMessage });
}

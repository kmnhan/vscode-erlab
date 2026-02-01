/**
 * Unit tests for kernel mock utilities.
 *
 * These tests verify the mock infrastructure works correctly.
 * NOTE: These tests are VS Code-independent and run with plain mocha.
 */
import * as assert from 'assert';
import {
	createMockKernel,
	createMockKernelWithResponse,
	createMockKernelWithError,
	createMockKernelWithMultipleOutputs,
	createMockJupyterApi,
	createMockJupyterApiNoKernel,
	createXarrayQueryResponse,
	createErrorResponse,
	type CancellationTokenLike,
	type UriLike,
} from '../mocks/kernelMock';

suite('Kernel Mocks', function () {
	// Mock cancellation token that is never cancelled
	const mockToken: CancellationTokenLike = { isCancellationRequested: false };

	// Mock URI
	const mockUri: UriLike = { toString: () => 'file:///path/to/notebook.ipynb' };

	suite('createMockKernel', function () {
		test('returns mapped response for matching code', async function () {
			const responses = new Map<string, string>();
			responses.set('print("hello")', 'hello\n');
			responses.set('1 + 1', '2');

			const kernel = createMockKernel(responses);
			const outputs: string[] = [];

			for await (const output of kernel.executeCode('print("hello")', mockToken as never)) {
				for (const item of output.items) {
					if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
						outputs.push(new TextDecoder().decode(item.data));
					}
				}
			}

			assert.strictEqual(outputs.join(''), 'hello\n');
		});

		test('returns empty string for unmapped code', async function () {
			const responses = new Map<string, string>();
			responses.set('mapped', 'value');

			const kernel = createMockKernel(responses);
			const outputs: string[] = [];

			for await (const output of kernel.executeCode('unmapped', mockToken as never)) {
				for (const item of output.items) {
					if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
						outputs.push(new TextDecoder().decode(item.data));
					}
				}
			}

			assert.strictEqual(outputs.join(''), '');
		});
	});

	suite('createMockKernelWithResponse', function () {
		test('returns same response for any code', async function () {
			const kernel = createMockKernelWithResponse('fixed response');
			const outputs: string[] = [];

			for await (const output of kernel.executeCode('any code here', mockToken as never)) {
				for (const item of output.items) {
					if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
						outputs.push(new TextDecoder().decode(item.data));
					}
				}
			}

			assert.strictEqual(outputs.join(''), 'fixed response');
		});
	});

	suite('createMockKernelWithError', function () {
		test('throws error on execution', async function () {
			const kernel = createMockKernelWithError('Kernel crashed');

			await assert.rejects(
				async () => {
					for await (const _ of kernel.executeCode('code', mockToken as never)) {
						// Should not reach here
					}
				},
				{ message: 'Kernel crashed' }
			);
		});
	});

	suite('createMockKernelWithMultipleOutputs', function () {
		test('yields all outputs in sequence', async function () {
			const kernel = createMockKernelWithMultipleOutputs(['first', 'second', 'third']);
			const outputs: string[] = [];

			for await (const output of kernel.executeCode('code', mockToken as never)) {
				for (const item of output.items) {
					if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
						outputs.push(new TextDecoder().decode(item.data));
					}
				}
			}

			assert.deepStrictEqual(outputs, ['first', 'second', 'third']);
		});
	});

	suite('createMockJupyterApi', function () {
		test('returns kernel for any URI', async function () {
			const kernel = createMockKernelWithResponse('test');
			const api = createMockJupyterApi(kernel);

			const result = await api.kernels?.getKernel(mockUri as never);

			assert.ok(result, 'Expected kernel to be returned');
			assert.strictEqual(result, kernel);
		});
	});

	suite('createMockJupyterApiNoKernel', function () {
		test('returns undefined for any URI', async function () {
			const api = createMockJupyterApiNoKernel();

			const result = await api.kernels?.getKernel(mockUri as never);

			assert.strictEqual(result, undefined);
		});
	});

	suite('Response helpers', function () {
		test('createXarrayQueryResponse generates valid JSON', function () {
			const response = createXarrayQueryResponse([
				{
					variableName: 'da',
					type: 'DataArray',
					name: 'test',
					dims: ['x', 'y'],
					sizes: { x: 10, y: 20 },
					shape: [10, 20],
					dtype: 'float64',
					ndim: 2,
					watched: false,
				},
			]);

			const parsed = JSON.parse(response);
			assert.ok(Array.isArray(parsed));
			assert.strictEqual(parsed.length, 1);
			assert.strictEqual(parsed[0].variableName, 'da');
			assert.strictEqual(parsed[0].type, 'DataArray');
		});

		test('createErrorResponse generates valid error JSON', function () {
			const response = createErrorResponse('Something went wrong');
			const parsed = JSON.parse(response);

			assert.strictEqual(parsed.error, 'Something went wrong');
		});
	});
});

/**
 * Contract tests for notebook kernel API types.
 *
 * These tests verify that Jupyter and marimo API type structures match
 * what the extension expects at runtime.
 *
 * NOTE: These are structural/shape tests that run without VS Code.
 * Runtime verification happens in the kernel smoke tests.
 */
import * as assert from 'assert';
import type { JupyterApi, KernelLike, KernelOutput, KernelOutputItem, MarimoApi } from '../../kernel/types.js';

suite('Jupyter API Contract Tests', function () {
	suite('JupyterApi type structure', function () {
		test('JupyterApi has optional kernels property', function () {
			// This test verifies compile-time structure by creating conformant objects
			const apiWithKernels: JupyterApi = {
				kernels: {
					getKernel: async () => undefined,
				},
			};
			const apiWithoutKernels: JupyterApi = {};

			assert.ok(apiWithKernels.kernels, 'API with kernels should have kernels');
			assert.ok(!apiWithoutKernels.kernels, 'API without kernels is valid');
		});

		test('kernels.getKernel returns Thenable<KernelLike | undefined>', async function () {
			const mockKernel: KernelLike = {
				executeCode: () => ({
					[Symbol.asyncIterator]: async function* () {
						// Empty iterator
					},
				}),
			};

			const api: JupyterApi = {
				kernels: {
					getKernel: async () => mockKernel,
				},
			};

			const result = await api.kernels?.getKernel({ toString: () => 'test://uri' } as never);
			assert.ok(result, 'getKernel should return a kernel');
			assert.strictEqual(typeof result.executeCode, 'function', 'Kernel should have executeCode method');
		});

		test('getKernel can return undefined when no kernel', async function () {
			const api: JupyterApi = {
				kernels: {
					getKernel: async () => undefined,
				},
			};

			const result = await api.kernels?.getKernel({ toString: () => 'test://uri' } as never);
			assert.strictEqual(result, undefined, 'getKernel should return undefined when no kernel');
		});
	});

	suite('MarimoApi type structure', function () {
		test('MarimoApi has optional experimental.kernels property', function () {
			const apiWithKernels: MarimoApi = {
				experimental: {
					kernels: {
						getKernel: async () => undefined,
					},
				},
			};
			const apiWithoutKernels: MarimoApi = {};

			assert.ok(apiWithKernels.experimental?.kernels, 'API with kernels should have experimental.kernels');
			assert.ok(!apiWithoutKernels.experimental?.kernels, 'API without experimental kernels is valid');
		});

		test('experimental.kernels.getKernel returns Thenable<KernelLike | undefined>', async function () {
			const mockKernel: KernelLike = {
				executeCode: () => ({
					[Symbol.asyncIterator]: async function* () {
						// Empty iterator
					},
				}),
			};

			const api: MarimoApi = {
				experimental: {
					kernels: {
						getKernel: async () => mockKernel,
					},
				},
			};

			const result = await api.experimental?.kernels?.getKernel({ toString: () => 'test://uri' } as never);
			assert.ok(result, 'getKernel should return a kernel');
			assert.strictEqual(typeof result.executeCode, 'function', 'Kernel should have executeCode method');
		});
	});

	suite('KernelLike type structure', function () {
		test('KernelLike.executeCode returns AsyncIterable<KernelOutput>', async function () {
			const outputs: KernelOutput[] = [];
			const kernel: KernelLike = {
				executeCode: (_code, _token) => ({
					[Symbol.asyncIterator]: async function* () {
						yield {
							items: [{ mime: 'text/plain', data: new TextEncoder().encode('test') }],
						};
					},
				}),
			};

			const mockToken = { isCancellationRequested: false } as never;
			for await (const output of kernel.executeCode('test', mockToken)) {
				outputs.push(output);
			}

			assert.strictEqual(outputs.length, 1, 'Should yield one output');
			assert.ok(outputs[0].items, 'Output should have items');
		});

		test('executeCode code parameter is string', function () {
			// Compile-time check - this would fail to compile if executeCode didn't accept string
			const kernel: KernelLike = {
				executeCode: (code: string, _token) => {
					assert.strictEqual(typeof code, 'string', 'Code should be string');
					return {
						[Symbol.asyncIterator]: async function* () {
							// Empty
						},
					};
				},
			};

			const mockToken = { isCancellationRequested: false } as never;
			// Just verify it doesn't throw
			kernel.executeCode('print("hello")', mockToken);
		});
	});

	suite('KernelOutput type structure', function () {
		test('KernelOutput has items array', function () {
			const output: KernelOutput = {
				items: [],
			};
			assert.ok(Array.isArray(output.items), 'items should be an array');
		});

		test('KernelOutput can have optional metadata', function () {
			const outputWithMeta: KernelOutput = {
				items: [],
				metadata: { foo: 'bar' },
			};
			const outputWithoutMeta: KernelOutput = {
				items: [],
			};

			assert.ok(outputWithMeta.metadata, 'Output can have metadata');
			assert.ok(!outputWithoutMeta.metadata, 'Output without metadata is valid');
		});
	});

	suite('KernelOutputItem type structure', function () {
		test('KernelOutputItem has mime and data properties', function () {
			const item: KernelOutputItem = {
				mime: 'text/plain',
				data: 'test data',
			};

			assert.strictEqual(item.mime, 'text/plain', 'Should have mime property');
			assert.strictEqual(item.data, 'test data', 'Should have data property');
		});

		test('KernelOutputItem.data can be Uint8Array', function () {
			const item: KernelOutputItem = {
				mime: 'text/plain',
				data: new Uint8Array([104, 101, 108, 108, 111]), // "hello"
			};

			assert.ok(item.data instanceof Uint8Array, 'data can be Uint8Array');
			const decoded = new TextDecoder().decode(item.data);
			assert.strictEqual(decoded, 'hello', 'Should decode correctly');
		});

		test('KernelOutputItem supports common mime types', function () {
			const textPlain: KernelOutputItem = { mime: 'text/plain', data: '' };
			const textHtml: KernelOutputItem = { mime: 'text/html', data: '' };
			const appJson: KernelOutputItem = { mime: 'application/json', data: {} };
			const appError: KernelOutputItem = { mime: 'application/vnd.code.notebook.error', data: {} };
			const appStdout: KernelOutputItem = { mime: 'application/vnd.code.notebook.stdout', data: '' };
			const appStderr: KernelOutputItem = { mime: 'application/vnd.code.notebook.stderr', data: '' };

			// Just verify all compile and have expected mime types
			assert.strictEqual(textPlain.mime, 'text/plain');
			assert.strictEqual(textHtml.mime, 'text/html');
			assert.strictEqual(appJson.mime, 'application/json');
			assert.strictEqual(appError.mime, 'application/vnd.code.notebook.error');
			assert.strictEqual(appStdout.mime, 'application/vnd.code.notebook.stdout');
			assert.strictEqual(appStderr.mime, 'application/vnd.code.notebook.stderr');
		});
	});

	suite('API defensive checks', function () {
		test('Extension code handles missing kernels property', function () {
			// Simulate what extension code should do
			const api: JupyterApi = {};

			const hasKernels = !!(api.kernels && typeof api.kernels.getKernel === 'function');
			assert.strictEqual(hasKernels, false, 'Should detect missing kernels');
		});

		test('Extension code handles undefined kernel result', async function () {
			const api: JupyterApi = {
				kernels: {
					getKernel: async () => undefined,
				},
			};

			const kernel = await api.kernels?.getKernel({ toString: () => 'test://uri' } as never);
			const canExecute = !!(kernel && typeof kernel.executeCode === 'function');
			assert.strictEqual(canExecute, false, 'Should detect undefined kernel');
		});

		test('Extension code handles kernel without executeCode', async function () {
			const api: JupyterApi = {
				kernels: {
					getKernel: async () => ({} as KernelLike), // Malformed kernel
				},
			};

			const kernel = await api.kernels?.getKernel({ toString: () => 'test://uri' } as never);
			const canExecute = kernel && typeof kernel.executeCode === 'function';
			assert.strictEqual(canExecute, false, 'Should detect kernel without executeCode');
		});
	});

	suite('Output parsing compatibility', function () {
		test('Text output can be decoded from Uint8Array', function () {
			const data = new TextEncoder().encode('{"result": 42}\n');
			const output: KernelOutput = {
				items: [{ mime: 'text/plain', data }],
			};

			const item = output.items[0];
			if (item.data instanceof Uint8Array) {
				const text = new TextDecoder().decode(item.data);
				assert.strictEqual(text, '{"result": 42}\n', 'Should decode UTF-8');
			}
		});

		test('Multiple outputs can be concatenated', async function () {
			const kernel: KernelLike = {
				executeCode: () => ({
					[Symbol.asyncIterator]: async function* () {
						yield { items: [{ mime: 'text/plain', data: new TextEncoder().encode('part1') }] };
						yield { items: [{ mime: 'text/plain', data: new TextEncoder().encode('part2') }] };
						yield { items: [{ mime: 'text/plain', data: new TextEncoder().encode('part3') }] };
					},
				}),
			};

			const chunks: string[] = [];
			const mockToken = { isCancellationRequested: false } as never;

			for await (const output of kernel.executeCode('test', mockToken)) {
				for (const item of output.items) {
					if (item.mime === 'text/plain' && item.data instanceof Uint8Array) {
						chunks.push(new TextDecoder().decode(item.data));
					}
				}
			}

			assert.deepStrictEqual(chunks, ['part1', 'part2', 'part3'], 'Should collect all parts');
			assert.strictEqual(chunks.join(''), 'part1part2part3', 'Should concatenate correctly');
		});
	});
});

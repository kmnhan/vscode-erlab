/**
 * Unit tests for kernel output parsing utilities.
 */
import * as assert from 'assert';
import {
	buildKernelCommandEnvelope,
	classifyKernelErrorOutput,
	extractKernelCommandEnvelopeResult,
	extractLastJsonLine,
	normalizeKernelError,
	decodeKernelOutputItem,
	selectKernelExecutionError,
	summarizeKernelCommandEnvelopeError,
} from '../../kernel/outputParsing';

suite('Kernel Output Parsing', () => {
	suite('extractLastJsonLine', () => {
		test('extracts JSON object from single line', () => {
			const result = extractLastJsonLine('{"name": "test"}');
			assert.strictEqual(result, '{"name": "test"}');
		});

		test('extracts last JSON line from multiline output', () => {
			const output = 'Some debug output\nMore output\n{"result": 42}';
			const result = extractLastJsonLine(output);
			assert.strictEqual(result, '{"result": 42}');
		});

		test('extracts JSON array', () => {
			const result = extractLastJsonLine('[1, 2, 3]');
			assert.strictEqual(result, '[1, 2, 3]');
		});

		test('extracts null', () => {
			const result = extractLastJsonLine('null');
			assert.strictEqual(result, 'null');
		});

		test('handles whitespace and empty lines', () => {
			const output = '  \n  {"data": true}  \n  \n';
			const result = extractLastJsonLine(output);
			assert.strictEqual(result, '{"data": true}');
		});

		test('returns undefined for non-JSON output', () => {
			const result = extractLastJsonLine('Hello world');
			assert.strictEqual(result, undefined);
		});

		test('returns undefined for empty string', () => {
			const result = extractLastJsonLine('');
			assert.strictEqual(result, undefined);
		});

		test('skips non-JSON lines to find JSON', () => {
			const output = 'Processing...\nDone!\n{"status": "ok"}\nFinal cleanup';
			// Should find the JSON line even though there's text after
			const result = extractLastJsonLine(output);
			assert.strictEqual(result, '{"status": "ok"}');
		});

		test('handles Windows line endings', () => {
			const output = 'Line 1\r\n{"value": 123}\r\n';
			const result = extractLastJsonLine(output);
			assert.strictEqual(result, '{"value": 123}');
		});
	});

	suite('normalizeKernelError', () => {
		test('extracts message from JSON error', () => {
			const raw = '{"name": "TypeError", "message": "invalid operation"}';
			const result = normalizeKernelError(raw);
			assert.strictEqual(result, 'TypeError: invalid operation');
		});

		test('extracts message without name', () => {
			const raw = '{"message": "Something went wrong"}';
			const result = normalizeKernelError(raw);
			assert.strictEqual(result, 'Something went wrong');
		});

		test('returns raw string for non-JSON', () => {
			const raw = 'Plain error message';
			const result = normalizeKernelError(raw);
			assert.strictEqual(result, 'Plain error message');
		});

		test('returns raw string for JSON without message', () => {
			const raw = '{"code": 500}';
			const result = normalizeKernelError(raw);
			assert.strictEqual(result, '{"code": 500}');
		});

		test('returns raw string for invalid JSON', () => {
			const raw = '{not valid json}';
			const result = normalizeKernelError(raw);
			assert.strictEqual(result, '{not valid json}');
		});
	});

	suite('kernel command envelope', () => {
		test('builds wrapped code with marker output', () => {
			const marker = '__marker__:';
			const wrapped = buildKernelCommandEnvelope('print("hello")', marker);
			assert.ok(wrapped.includes('try:'));
			assert.ok(wrapped.includes('except BaseException as __erlab_tmp__exc:'));
			assert.ok(wrapped.includes('__erlab_tmp__code ='));
			assert.ok(wrapped.includes('exec(compile(__erlab_tmp__code'));
			assert.ok(wrapped.includes('__erlab_tmp__sys.stdout.write'));
			assert.ok(wrapped.includes(JSON.stringify(marker)));
		});

		test('extracts structured result and strips marker line', () => {
			const marker = '__marker__:';
			const output = `hello\n${marker}{"ok":true}\n`;
			const parsed = extractKernelCommandEnvelopeResult(output, marker);
			assert.strictEqual(parsed.result?.ok, true);
			assert.strictEqual(parsed.cleanedOutput.trim(), 'hello');
		});

		test('keeps malformed marker line in output', () => {
			const marker = '__marker__:';
			const output = `hello\n${marker}not-json`;
			const parsed = extractKernelCommandEnvelopeResult(output, marker);
			assert.strictEqual(parsed.result, undefined);
			assert.ok(parsed.cleanedOutput.includes(`${marker}not-json`));
		});

		test('summarizes structured error without traceback parsing', () => {
			const parsed = summarizeKernelCommandEnvelopeError({
				ok: false,
				exc_type: 'RuntimeError',
				message: 'manager not running',
				traceback: 'Traceback ...',
			});
			assert.strictEqual(parsed.summary, 'RuntimeError: manager not running');
			assert.ok(parsed.traceback?.includes('Traceback'));
		});
	});

	suite('selectKernelExecutionError', () => {
		test('prefers envelope error over transport errors', () => {
			const selected = selectKernelExecutionError({
				transportErrors: ['Traceback ... RuntimeError: noisy'],
				envelopeResult: {
					ok: false,
					exc_type: 'RuntimeError',
					message: 'manager not running',
					traceback: 'Traceback ...',
				},
			});
			assert.strictEqual(selected.message, 'RuntimeError: manager not running');
			assert.strictEqual(selected.source, 'envelope');
			assert.ok(selected.traceback?.includes('Traceback'));
		});

		test('ignores transport errors when envelope reports success', () => {
			const selected = selectKernelExecutionError({
				transportErrors: ['RuntimeError: noisy'],
				envelopeResult: { ok: true },
			});
			assert.strictEqual(selected.message, undefined);
			assert.strictEqual(selected.source, undefined);
		});

		test('falls back to normalized transport errors when no envelope result', () => {
			const selected = selectKernelExecutionError({
				transportErrors: [' RuntimeError: failed ', 'RuntimeError: failed', 'ValueError: bad'],
			});
			assert.strictEqual(selected.message, 'RuntimeError: failed; ValueError: bad');
			assert.strictEqual(selected.source, 'transport');
		});
	});

	suite('classifyKernelErrorOutput', () => {
		const errorMime = 'application/vnd.code.notebook.error';
		const stderrMime = 'application/vnd.code.notebook.stderr';

		test('detects VS Code error mime for any provider', () => {
			const result = classifyKernelErrorOutput({
				provider: 'marimo',
				item: { mime: errorMime, data: '{"name":"TypeError","message":"bad"}' },
				errorMime,
				stderrMime,
			});
			assert.strictEqual(result, 'TypeError: bad');
		});

		test('detects marimo stderr channel errors', () => {
			const result = classifyKernelErrorOutput({
				provider: 'marimo',
				outputChannel: 'stderr',
				item: { mime: stderrMime, data: 'RuntimeError: manager not running' },
				errorMime,
				stderrMime,
			});
			assert.strictEqual(result, 'RuntimeError: manager not running');
		});

		test('keeps marimo stderr traceback content as fallback output', () => {
			const result = classifyKernelErrorOutput({
				provider: 'marimo',
				outputChannel: 'stderr',
				item: {
					mime: stderrMime,
					data: 'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nRuntimeError: manager not running',
				},
				errorMime,
				stderrMime,
			});
			assert.strictEqual(
				result,
				'Traceback (most recent call last):\n  File "<stdin>", line 1, in <module>\nRuntimeError: manager not running'
			);
		});

		test('detects marimo-error channel with html content', () => {
			const result = classifyKernelErrorOutput({
				provider: 'marimo',
				outputChannel: 'marimo-error',
				item: { mime: 'text/html', data: '<b>RuntimeError</b>: failed' },
				errorMime,
				stderrMime,
			});
			assert.strictEqual(result, 'RuntimeError: failed');
		});

		test('ignores marimo html traceback fallback without explicit error channel', () => {
			const result = classifyKernelErrorOutput({
				provider: 'marimo',
				outputChannel: 'output',
				item: {
					mime: 'text/html',
					data: '<b>Traceback (most recent call last):</b>\nRuntimeError: failed',
				},
				errorMime,
				stderrMime,
			});
			assert.strictEqual(result, undefined);
		});

		test('ignores jupyter stderr mime output', () => {
			const result = classifyKernelErrorOutput({
				provider: 'jupyter',
				outputChannel: 'stderr',
				item: { mime: stderrMime, data: 'warning text' },
				errorMime,
				stderrMime,
			});
			assert.strictEqual(result, undefined);
		});
	});

	suite('decodeKernelOutputItem', () => {
		test('decodes Uint8Array', () => {
			const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
			const result = decodeKernelOutputItem({ mime: 'text/plain', data });
			assert.strictEqual(result, 'Hello');
		});

		test('decodes ArrayBuffer', () => {
			const buffer = new ArrayBuffer(5);
			const view = new Uint8Array(buffer);
			view.set([72, 105, 33, 33, 33]); // "Hi!!!"
			const result = decodeKernelOutputItem({ mime: 'text/plain', data: buffer });
			assert.strictEqual(result, 'Hi!!!');
		});

		test('returns string data directly', () => {
			const result = decodeKernelOutputItem({ mime: 'text/plain', data: 'Direct string' });
			assert.strictEqual(result, 'Direct string');
		});

		test('JSON-stringifies object data', () => {
			const result = decodeKernelOutputItem({ mime: 'application/json', data: { key: 'value' } });
			assert.strictEqual(result, '{"key":"value"}');
		});

		test('JSON-stringifies array data', () => {
			const result = decodeKernelOutputItem({ mime: 'application/json', data: [1, 2, 3] });
			assert.strictEqual(result, '[1,2,3]');
		});

		test('handles DataView', () => {
			const buffer = new ArrayBuffer(4);
			const view = new Uint8Array(buffer);
			view.set([84, 101, 115, 116]); // "Test"
			const dataView = new DataView(buffer);
			const result = decodeKernelOutputItem({ mime: 'text/plain', data: dataView });
			assert.strictEqual(result, 'Test');
		});
	});
});

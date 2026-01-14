/**
 * Unit tests for kernel output parsing utilities.
 */
import * as assert from 'assert';
import {
	extractLastJsonLine,
	normalizeKernelError,
	decodeKernelOutputItem,
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

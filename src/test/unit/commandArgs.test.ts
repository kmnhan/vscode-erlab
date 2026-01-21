/**
 * Unit tests for command argument encoding and normalization.
 */
import * as assert from 'assert';
import { encodeCommandArgs, normalizeJupyterVariableViewerArgs } from '../../commands/args';

suite('Command Args', () => {
	suite('encodeCommandArgs', () => {
		test('encodes simple object', () => {
			const result = encodeCommandArgs({ variableName: 'data' });
			assert.strictEqual(result, encodeURIComponent('{"variableName":"data"}'));
		});

		test('encodes object with multiple properties', () => {
			const result = encodeCommandArgs({
				variableName: 'myArray',
				ndim: 3,
				notebookUri: 'file:///path/to/notebook.ipynb',
			});
			const decoded = JSON.parse(decodeURIComponent(result));
			assert.strictEqual(decoded.variableName, 'myArray');
			assert.strictEqual(decoded.ndim, 3);
			assert.strictEqual(decoded.notebookUri, 'file:///path/to/notebook.ipynb');
		});

		test('encodes boolean values', () => {
			const result = encodeCommandArgs({ reveal: true, watched: false });
			const decoded = JSON.parse(decodeURIComponent(result));
			assert.strictEqual(decoded.reveal, true);
			assert.strictEqual(decoded.watched, false);
		});

		test('encodes null and undefined values', () => {
			const result = encodeCommandArgs({ value: null, other: undefined });
			const decoded = JSON.parse(decodeURIComponent(result));
			assert.strictEqual(decoded.value, null);
			assert.strictEqual('other' in decoded, false); // undefined is omitted
		});

		test('encodes special characters in strings', () => {
			const result = encodeCommandArgs({ name: 'data with spaces & symbols!' });
			const decoded = JSON.parse(decodeURIComponent(result));
			assert.strictEqual(decoded.name, 'data with spaces & symbols!');
		});

		test('result is URL-safe', () => {
			const result = encodeCommandArgs({ uri: 'file:///path?query=1&other=2' });
			// Should not contain raw & or ? or = that would break URL parsing
			assert.ok(!result.includes('&') || result === encodeURIComponent(result));
		});

		test('roundtrip preserves data', () => {
			const original = {
				variableName: 'test_array',
				ndim: 4,
				watched: true,
				notebookUri: 'file:///Users/test/notebook.ipynb',
			};
			const encoded = encodeCommandArgs(original);
			const decoded = JSON.parse(decodeURIComponent(encoded));
			assert.deepStrictEqual(decoded, original);
		});
	});

	suite('normalizeJupyterVariableViewerArgs', () => {
		test('maps Jupyter variable viewer args to xarray args', () => {
			const result = normalizeJupyterVariableViewerArgs({
				name: 'data',
				type: 'DataArray',
				fileName: 'file:///path/to/notebook.ipynb',
			});
			assert.strictEqual(result?.variableName, 'data');
			assert.strictEqual(result?.notebookUri, 'file:///path/to/notebook.ipynb');
			assert.strictEqual(result?.type, 'DataArray');
		});

		test('ignores non-xarray types from variable viewer args', () => {
			const result = normalizeJupyterVariableViewerArgs({
				name: 'data',
				type: 'Other',
				fileName: 'file:///path/to/notebook.ipynb',
			});
			assert.strictEqual(result?.variableName, 'data');
			assert.strictEqual(result?.type, undefined);
		});

		test('handles wrapped variable payloads', () => {
			const result = normalizeJupyterVariableViewerArgs({
				variable: {
					name: 'data',
					type: 'Dataset',
					notebookUri: 'file:///path/to/notebook.ipynb',
				},
			});
			assert.strictEqual(result?.variableName, 'data');
			assert.strictEqual(result?.type, 'Dataset');
			assert.strictEqual(result?.notebookUri, 'file:///path/to/notebook.ipynb');
		});

		test('handles variableName fallback', () => {
			const result = normalizeJupyterVariableViewerArgs({
				variableName: 'data',
				type: 'DataTree',
				fileName: 'file:///path/to/notebook.ipynb',
			});
			assert.strictEqual(result?.variableName, 'data');
			assert.strictEqual(result?.type, 'DataTree');
		});
	});
});

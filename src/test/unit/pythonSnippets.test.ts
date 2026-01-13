/**
 * Unit tests for Python snippet builders.
 */
import * as assert from 'assert';
import { buildDataArrayHtmlCode } from '../../features/dataArray/pythonSnippets';

suite('Python Snippets', () => {
	suite('buildDataArrayHtmlCode', () => {
		test('generates code with default options when none provided', () => {
			const code = buildDataArrayHtmlCode('myvar');
			assert.ok(code.includes('display_expand_attrs=True'));
			assert.ok(code.includes('display_expand_coords=True'));
			assert.ok(code.includes('display_expand_data=False'));
		});

		test('generates code with all options true', () => {
			const code = buildDataArrayHtmlCode('myvar', {
				displayExpandAttrs: true,
				displayExpandCoords: true,
				displayExpandData: true,
			});
			assert.ok(code.includes('display_expand_attrs=True'));
			assert.ok(code.includes('display_expand_coords=True'));
			assert.ok(code.includes('display_expand_data=True'));
		});

		test('generates code with all options false', () => {
			const code = buildDataArrayHtmlCode('myvar', {
				displayExpandAttrs: false,
				displayExpandCoords: false,
				displayExpandData: false,
			});
			assert.ok(code.includes('display_expand_attrs=False'));
			assert.ok(code.includes('display_expand_coords=False'));
			assert.ok(code.includes('display_expand_data=False'));
		});

		test('generates code with mixed options', () => {
			const code = buildDataArrayHtmlCode('myvar', {
				displayExpandAttrs: true,
				displayExpandCoords: false,
				displayExpandData: true,
			});
			assert.ok(code.includes('display_expand_attrs=True'));
			assert.ok(code.includes('display_expand_coords=False'));
			assert.ok(code.includes('display_expand_data=True'));
		});

		test('uses default values for undefined options', () => {
			const code = buildDataArrayHtmlCode('myvar', {
				displayExpandAttrs: false,
				// displayExpandCoords not specified - should default to true
				// displayExpandData not specified - should default to false
			});
			assert.ok(code.includes('display_expand_attrs=False'));
			assert.ok(code.includes('display_expand_coords=True'));
			assert.ok(code.includes('display_expand_data=False'));
		});

		test('includes variable name in generated code', () => {
			const code = buildDataArrayHtmlCode('my_data_array');
			assert.ok(code.includes('__erlab_tmp__value = my_data_array'));
		});

		test('generates valid xr.set_options call', () => {
			const code = buildDataArrayHtmlCode('myvar');
			// Check that it's a proper context manager call
			assert.ok(code.includes('with xr.set_options('));
			// Check all three options are in the same call
			const setOptionsLine = code.split('\n').find(line => line.includes('xr.set_options'));
			assert.ok(setOptionsLine);
			assert.ok(setOptionsLine.includes('display_expand_attrs='));
			assert.ok(setOptionsLine.includes('display_expand_coords='));
			assert.ok(setOptionsLine.includes('display_expand_data='));
		});
	});
});

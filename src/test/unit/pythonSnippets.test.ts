/**
 * Unit tests for Python snippet builders.
 */
import * as assert from 'assert';
import { buildXarrayHtmlCode, buildXarrayQueryCode } from '../../features/xarray/pythonSnippets';

suite('Python Snippets', () => {
		suite('buildXarrayHtmlCode', () => {
			test('generates code with default options when none provided', () => {
				const code = buildXarrayHtmlCode('myvar');
				assert.ok(!code.includes('import IPython'));
				assert.ok(code.includes('display_expand_attrs=True'));
				assert.ok(code.includes('display_expand_coords=True'));
				assert.ok(code.includes('display_expand_data=False'));
		});

		test('generates code with all options true', () => {
			const code = buildXarrayHtmlCode('myvar', {
				displayExpandAttrs: true,
				displayExpandCoords: true,
				displayExpandData: true,
			});
			assert.ok(code.includes('display_expand_attrs=True'));
			assert.ok(code.includes('display_expand_coords=True'));
			assert.ok(code.includes('display_expand_data=True'));
		});

		test('generates code with all options false', () => {
			const code = buildXarrayHtmlCode('myvar', {
				displayExpandAttrs: false,
				displayExpandCoords: false,
				displayExpandData: false,
			});
			assert.ok(code.includes('display_expand_attrs=False'));
			assert.ok(code.includes('display_expand_coords=False'));
			assert.ok(code.includes('display_expand_data=False'));
		});

		test('generates code with mixed options', () => {
			const code = buildXarrayHtmlCode('myvar', {
				displayExpandAttrs: true,
				displayExpandCoords: false,
				displayExpandData: true,
			});
			assert.ok(code.includes('display_expand_attrs=True'));
			assert.ok(code.includes('display_expand_coords=False'));
			assert.ok(code.includes('display_expand_data=True'));
		});

		test('uses default values for undefined options', () => {
			const code = buildXarrayHtmlCode('myvar', {
				displayExpandAttrs: false,
				// displayExpandCoords not specified - should default to true
				// displayExpandData not specified - should default to false
			});
			assert.ok(code.includes('display_expand_attrs=False'));
			assert.ok(code.includes('display_expand_coords=True'));
			assert.ok(code.includes('display_expand_data=False'));
		});

		test('includes variable name in generated code', () => {
			const code = buildXarrayHtmlCode('my_data_array');
			assert.ok(code.includes('__erlab_tmp__value = my_data_array'));
		});

		test('generates valid xr.set_options call', () => {
			const code = buildXarrayHtmlCode('myvar');
			// Check that it's a proper context manager call
			assert.ok(code.includes('with xr.set_options('));
			// Check all three options are in the same call
			const setOptionsLine = code.split('\n').find((line: string) => line.includes('xr.set_options'));
			assert.ok(setOptionsLine);
			assert.ok(setOptionsLine.includes('display_expand_attrs='));
			assert.ok(setOptionsLine.includes('display_expand_coords='));
			assert.ok(setOptionsLine.includes('display_expand_data='));
		});
	});

		suite('buildXarrayQueryCode', () => {
			test('uses globals fallback when IPython namespace is unavailable', () => {
				const code = buildXarrayQueryCode();
				assert.ok(code.includes('__erlab_tmp__user_ns = globals()'));
			});

			test('does not require IPython import in generated code', () => {
				const listCode = buildXarrayQueryCode();
				const singleCode = buildXarrayQueryCode('myvar');
				assert.ok(!singleCode.includes('import IPython'));
				assert.ok(!listCode.includes('\nimport IPython\n'));
				assert.ok(listCode.includes('import IPython as __erlab_tmp__IPython'));
			});

		test('uses erlab watcher API for watched variables', () => {
			const code = buildXarrayQueryCode();
			assert.ok(code.includes('erlab.interactive.imagetool.manager'));
			assert.ok(code.includes('watched_variables()'));
			assert.ok(code.includes('if not callable(getattr(__erlab_tmp__manager, "watched_variables", None)):'));
			assert.ok(code.includes('watched variable status requires erlab 3.20.0 or later. Please upgrade erlab.'));
			assert.ok(!code.includes('__erlab_watched_vars__'));
		});
	});
});

/**
 * Unit tests for xarray formatting utilities.
 */
import * as assert from 'assert';
import { formatXarrayLabel, formatDimsWithSizes } from '../../features/xarray/formatting';
import type { XarrayEntry } from '../../features/xarray/types';

suite('xarray Formatting', () => {
	suite('formatDimsWithSizes', () => {
		test('formats single dimension', () => {
			const result = formatDimsWithSizes(['x'], { x: 100 });
			assert.strictEqual(result, 'x: 100');
		});

		test('formats multiple dimensions', () => {
			const result = formatDimsWithSizes(['x', 'y', 'z'], { x: 100, y: 200, z: 50 });
			assert.strictEqual(result, 'x: 100, y: 200, z: 50');
		});

		test('returns empty string for empty dims', () => {
			const result = formatDimsWithSizes([], {});
			assert.strictEqual(result, '');
		});

		test('handles missing size with question mark', () => {
			const result = formatDimsWithSizes(['x', 'y'], { x: 100 });
			assert.strictEqual(result, 'x: 100, y: ?');
		});

		test('preserves dimension order', () => {
			const result = formatDimsWithSizes(['z', 'y', 'x'], { x: 1, y: 2, z: 3 });
			assert.strictEqual(result, 'z: 3, y: 2, x: 1');
		});
	});

	suite('formatXarrayLabel', () => {
		test('formats DataArray with name and dims', () => {
			const info: XarrayEntry = {
				variableName: 'data',
				type: 'DataArray',
				name: 'temperature',
				dims: ['lat', 'lon'],
				sizes: { lat: 180, lon: 360 },
				shape: [180, 360],
				dtype: 'float64',
				ndim: 2,
				watched: false,
			};
			const result = formatXarrayLabel(info, 'data');
			assert.strictEqual(result, 'temperature (lat: 180, lon: 360)');
		});

		test('uses fallback name when name is undefined', () => {
			const info: XarrayEntry = {
				variableName: 'myVariable',
				type: 'DataArray',
				dims: ['x'],
				sizes: { x: 10 },
				shape: [10],
				dtype: 'int32',
				ndim: 1,
				watched: false,
			};
			const result = formatXarrayLabel(info, 'myVariable');
			assert.strictEqual(result, 'myVariable (x: 10)');
		});

		test('returns just name for scalar DataArray (no dims)', () => {
			const info: XarrayEntry = {
				variableName: 'scalar_value',
				type: 'DataArray',
				name: 'scalar_value',
				dims: [],
				sizes: {},
				shape: [],
				dtype: 'float64',
				ndim: 0,
				watched: false,
			};
			const result = formatXarrayLabel(info, 'fallback');
			assert.strictEqual(result, 'scalar_value');
		});

		test('returns fallback name for scalar without name', () => {
			const info: XarrayEntry = {
				variableName: 'my_scalar',
				type: 'DataArray',
				dims: [],
				sizes: {},
				shape: [],
				dtype: 'float64',
				ndim: 0,
				watched: false,
			};
			const result = formatXarrayLabel(info, 'my_scalar');
			assert.strictEqual(result, 'my_scalar');
		});

		test('handles 4D DataArray', () => {
			const info: XarrayEntry = {
				variableName: 'data',
				type: 'DataArray',
				name: 'data',
				dims: ['time', 'level', 'lat', 'lon'],
				sizes: { time: 12, level: 10, lat: 180, lon: 360 },
				shape: [12, 10, 180, 360],
				dtype: 'float32',
				ndim: 4,
				watched: false,
			};
			const result = formatXarrayLabel(info, 'fallback');
			assert.strictEqual(result, 'data (time: 12, level: 10, lat: 180, lon: 360)');
		});

		test('formats Dataset without dims', () => {
			const info: XarrayEntry = {
				variableName: 'ds',
				type: 'Dataset',
			};
			const result = formatXarrayLabel(info, 'ds');
			assert.strictEqual(result, 'ds');
		});

		test('formats DataTree without dims', () => {
			const info: XarrayEntry = {
				variableName: 'tree',
				type: 'DataTree',
			};
			const result = formatXarrayLabel(info, 'tree');
			assert.strictEqual(result, 'tree');
		});
	});
});

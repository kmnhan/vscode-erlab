/**
 * Unit tests for Python identifier validation.
 * These tests run without VS Code and are fast.
 */
import * as assert from 'assert';
import {
	isValidPythonIdentifier,
	isDunderName,
	PYTHON_KEYWORDS,
	PYTHON_BUILTINS,
	PYTHON_MAGIC_VARS,
} from '../../python/identifiers';

suite('Python Identifiers', () => {
	suite('isValidPythonIdentifier', () => {
		test('accepts valid variable names', () => {
			assert.strictEqual(isValidPythonIdentifier('x'), true);
			assert.strictEqual(isValidPythonIdentifier('myVar'), true);
			assert.strictEqual(isValidPythonIdentifier('my_var'), true);
			assert.strictEqual(isValidPythonIdentifier('_private'), true);
			assert.strictEqual(isValidPythonIdentifier('MyClass'), true);
			assert.strictEqual(isValidPythonIdentifier('var123'), true);
			assert.strictEqual(isValidPythonIdentifier('_'), true);
			assert.strictEqual(isValidPythonIdentifier('data_array'), true);
		});

		test('rejects empty strings', () => {
			assert.strictEqual(isValidPythonIdentifier(''), false);
		});

		test('rejects strings starting with numbers', () => {
			assert.strictEqual(isValidPythonIdentifier('1var'), false);
			assert.strictEqual(isValidPythonIdentifier('123'), false);
		});

		test('rejects strings with invalid characters', () => {
			assert.strictEqual(isValidPythonIdentifier('my-var'), false);
			assert.strictEqual(isValidPythonIdentifier('my var'), false);
			assert.strictEqual(isValidPythonIdentifier('my.var'), false);
			assert.strictEqual(isValidPythonIdentifier('var!'), false);
			assert.strictEqual(isValidPythonIdentifier('var@name'), false);
		});

		test('rejects Python keywords (case-insensitive)', () => {
			assert.strictEqual(isValidPythonIdentifier('if'), false);
			assert.strictEqual(isValidPythonIdentifier('for'), false);
			assert.strictEqual(isValidPythonIdentifier('while'), false);
			assert.strictEqual(isValidPythonIdentifier('class'), false);
			assert.strictEqual(isValidPythonIdentifier('def'), false);
			assert.strictEqual(isValidPythonIdentifier('return'), false);
			assert.strictEqual(isValidPythonIdentifier('True'), false);
			assert.strictEqual(isValidPythonIdentifier('False'), false);
			assert.strictEqual(isValidPythonIdentifier('None'), false);
			// Case variations
			assert.strictEqual(isValidPythonIdentifier('IF'), false);
			assert.strictEqual(isValidPythonIdentifier('For'), false);
		});

		test('rejects Python builtins', () => {
			assert.strictEqual(isValidPythonIdentifier('print'), false);
			assert.strictEqual(isValidPythonIdentifier('len'), false);
			assert.strictEqual(isValidPythonIdentifier('range'), false);
			assert.strictEqual(isValidPythonIdentifier('list'), false);
			assert.strictEqual(isValidPythonIdentifier('dict'), false);
			assert.strictEqual(isValidPythonIdentifier('str'), false);
			assert.strictEqual(isValidPythonIdentifier('int'), false);
			assert.strictEqual(isValidPythonIdentifier('type'), false);
		});

		test('rejects dunder names', () => {
			assert.strictEqual(isValidPythonIdentifier('__init__'), false);
			assert.strictEqual(isValidPythonIdentifier('__name__'), false);
			assert.strictEqual(isValidPythonIdentifier('__class__'), false);
			assert.strictEqual(isValidPythonIdentifier('__dict__'), false);
		});

		test('rejects magic variables', () => {
			assert.strictEqual(isValidPythonIdentifier('__file__'), false);
			assert.strictEqual(isValidPythonIdentifier('__doc__'), false);
			assert.strictEqual(isValidPythonIdentifier('__builtins__'), false);
		});

		test('accepts names that look like but are not keywords', () => {
			assert.strictEqual(isValidPythonIdentifier('if_condition'), true);
			assert.strictEqual(isValidPythonIdentifier('for_loop'), true);
			assert.strictEqual(isValidPythonIdentifier('my_class'), true);
			assert.strictEqual(isValidPythonIdentifier('printer'), true);
		});
	});

	suite('isDunderName', () => {
		test('identifies dunder names', () => {
			assert.strictEqual(isDunderName('__init__'), true);
			assert.strictEqual(isDunderName('__name__'), true);
			assert.strictEqual(isDunderName('__str__'), true);
			assert.strictEqual(isDunderName('__repr__'), true);
		});

		test('rejects non-dunder names', () => {
			assert.strictEqual(isDunderName('init'), false);
			assert.strictEqual(isDunderName('__init'), false);
			assert.strictEqual(isDunderName('init__'), false);
			assert.strictEqual(isDunderName('_init_'), false);
		});

		test('requires minimum length', () => {
			assert.strictEqual(isDunderName('____'), false); // 4 chars, not > 4
			assert.strictEqual(isDunderName('__a__'), true);  // 5 chars, is > 4
			assert.strictEqual(isDunderName('__ab__'), true); // 6 chars
		});
	});

	suite('Keyword and builtin sets', () => {
		test('PYTHON_KEYWORDS contains expected keywords', () => {
			assert.ok(PYTHON_KEYWORDS.has('if'));
			assert.ok(PYTHON_KEYWORDS.has('for'));
			assert.ok(PYTHON_KEYWORDS.has('while'));
			assert.ok(PYTHON_KEYWORDS.has('def'));
			assert.ok(PYTHON_KEYWORDS.has('class'));
			assert.ok(PYTHON_KEYWORDS.has('true'));
			assert.ok(PYTHON_KEYWORDS.has('false'));
			assert.ok(PYTHON_KEYWORDS.has('none'));
		});

		test('PYTHON_BUILTINS contains expected builtins', () => {
			assert.ok(PYTHON_BUILTINS.has('print'));
			assert.ok(PYTHON_BUILTINS.has('len'));
			assert.ok(PYTHON_BUILTINS.has('range'));
			assert.ok(PYTHON_BUILTINS.has('list'));
			assert.ok(PYTHON_BUILTINS.has('dict'));
			assert.ok(PYTHON_BUILTINS.has('__import__'));
		});

		test('PYTHON_MAGIC_VARS contains expected magic variables', () => {
			assert.ok(PYTHON_MAGIC_VARS.has('__name__'));
			assert.ok(PYTHON_MAGIC_VARS.has('__file__'));
			assert.ok(PYTHON_MAGIC_VARS.has('__doc__'));
		});
	});
});

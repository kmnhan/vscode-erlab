/**
 * Python identifier validation utilities.
 * Pure functions with no VS Code dependencies.
 */

export const PYTHON_KEYWORDS = new Set([
	'false', 'none', 'true',
	'and', 'as', 'assert', 'async', 'await',
	'break', 'class', 'continue', 'def', 'del',
	'elif', 'else', 'except', 'finally', 'for',
	'from', 'global', 'if', 'import', 'in',
	'is', 'lambda', 'nonlocal', 'not', 'or',
	'pass', 'raise', 'return', 'try', 'while',
	'with', 'yield',
]);

export const PYTHON_BUILTINS = new Set([
	'abs', 'aiter', 'all', 'anext', 'any', 'ascii', 'bin', 'bool', 'breakpoint',
	'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'compile', 'complex',
	'delattr', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'exec', 'filter',
	'float', 'format', 'frozenset', 'getattr', 'globals', 'hasattr', 'hash',
	'help', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
	'len', 'list', 'locals', 'map', 'max', 'memoryview', 'min', 'next', 'object',
	'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed',
	'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum',
	'super', 'tuple', 'type', 'vars', 'zip', '__import__',
]);

export const PYTHON_MAGIC_VARS = new Set([
	'__annotations__', '__builtins__', '__cached__', '__doc__', '__file__',
	'__loader__', '__name__', '__package__', '__spec__',
]);

export function isDunderName(value: string): boolean {
	return value.length > 4 && value.startsWith('__') && value.endsWith('__');
}

export function isValidPythonIdentifier(value: string): boolean {
	if (!value) {
		return false;
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		return false;
	}
	const lowered = value.toLowerCase();
	if (PYTHON_KEYWORDS.has(lowered)) {
		return false;
	}
	if (PYTHON_BUILTINS.has(value)) {
		return false;
	}
	if (isDunderName(value)) {
		return false;
	}
	if (PYTHON_MAGIC_VARS.has(value)) {
		return false;
	}
	return true;
}

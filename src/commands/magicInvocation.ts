/**
 * Python magic invocation code builders for erlab IPython magics.
 */

const ERLAB_TMP_PREFIX = '__erlab_tmp__';

/**
 * Build code to invoke an IPython magic with string arguments.
 */
export function buildMagicInvocation(magicName: string, args: string): string {
	return buildMagicInvocationWithArgsCode(magicName, [
		`${ERLAB_TMP_PREFIX}args = ${JSON.stringify(args)}`,
	]);
}

/**
 * Build code to invoke an IPython magic with custom argument lines.
 */
export function buildMagicInvocationWithArgsCode(magicName: string, argsLines: string[]): string {
	return [
		'import importlib.util',
		'import IPython',
		`if importlib.util.find_spec("erlab") is not None:`,
		`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
		`    if ${ERLAB_TMP_PREFIX}ip and "erlab.interactive" not in ${ERLAB_TMP_PREFIX}ip.extension_manager.loaded:`,
		`        ${ERLAB_TMP_PREFIX}ip.run_line_magic("load_ext", "erlab.interactive")`,
		`    if ${ERLAB_TMP_PREFIX}ip:`,
		...argsLines.map((line) => `        ${line}`),
		`        ${ERLAB_TMP_PREFIX}ip.run_line_magic(${JSON.stringify(magicName)}, ${ERLAB_TMP_PREFIX}args)`,
		`    try:`,
		`        del ${ERLAB_TMP_PREFIX}ip`,
		`        del ${ERLAB_TMP_PREFIX}args`,
		`    except Exception:`,
		`        pass`,
	].join('\n');
}

/**
 * Build code to invoke the itool magic, optionally using the manager.
 */
export function buildItoolInvocation(variableName: string, useManager: boolean): string {
	if (!useManager) {
		return buildMagicInvocation('itool', variableName);
	}
	return buildMagicInvocationWithArgsCode('itool', [
		`import erlab.interactive.imagetool.manager as ${ERLAB_TMP_PREFIX}manager`,
		`${ERLAB_TMP_PREFIX}args = ${JSON.stringify(variableName)}`,
		`if ${ERLAB_TMP_PREFIX}manager.is_running():`,
		`    ${ERLAB_TMP_PREFIX}args = ${JSON.stringify(`-m ${variableName}`)}`,
		`try:`,
		`    del ${ERLAB_TMP_PREFIX}manager`,
		`except Exception:`,
		`    pass`,
	]);
}

function buildMarimoVariableLookup(variableName: string): string[] {
	return [
		`${ERLAB_TMP_PREFIX}varname = ${JSON.stringify(variableName)}`,
		`${ERLAB_TMP_PREFIX}ns = globals()`,
		`if ${ERLAB_TMP_PREFIX}varname in ${ERLAB_TMP_PREFIX}ns:`,
		`    ${ERLAB_TMP_PREFIX}value = ${ERLAB_TMP_PREFIX}ns[${ERLAB_TMP_PREFIX}varname]`,
		'else:',
		`    raise NameError("Variable '" + ${ERLAB_TMP_PREFIX}varname + "' not found.")`,
	];
}

function indentLines(lines: string[], spaces: number): string[] {
	const prefix = ' '.repeat(spaces);
	return lines.map((line) => `${prefix}${line}`);
}

/**
 * Build code to invoke erlab interactive tools directly in marimo kernels.
 */
export function buildMarimoToolInvocation(toolName: string, variableName: string): string {
	return [
		'import importlib.util',
		`if importlib.util.find_spec("erlab") is not None:`,
		`    import erlab.interactive as ${ERLAB_TMP_PREFIX}interactive`,
		...buildMarimoVariableLookup(variableName).map((line) => `    ${line}`),
		`    getattr(${ERLAB_TMP_PREFIX}interactive, ${JSON.stringify(toolName)})(`,
		`        data=${ERLAB_TMP_PREFIX}value,`,
		`        data_name=${ERLAB_TMP_PREFIX}varname,`,
		'    )',
	].join('\n');
}

/**
 * Build code to invoke ImageTool directly in marimo kernels.
 */
export function buildMarimoItoolInvocation(variableName: string, useManager: boolean): string {
	return [
		'import importlib.util',
		`if importlib.util.find_spec("erlab") is not None:`,
		`    import erlab.interactive as ${ERLAB_TMP_PREFIX}interactive`,
		...buildMarimoVariableLookup(variableName).map((line) => `    ${line}`),
		`    ${ERLAB_TMP_PREFIX}interactive.itool(`,
		`        data=${ERLAB_TMP_PREFIX}value,`,
		`        manager=${useManager ? 'True' : 'False'},`,
		'    )',
	].join('\n');
}

export type MarimoWatchInvocationOptions = {
	unwatch: boolean;
};

/**
 * Build code to watch/unwatch variables via the erlab manager watcher API.
 *
 * This path does not rely on IPython magics and works for both marimo and
 * Jupyter kernels on current erlabpy versions.
 */
export function buildMarimoWatchInvocation(
	variableName: string,
	options: MarimoWatchInvocationOptions
): string {
	const applyWatchLines: string[] = options.unwatch
		? [`${ERLAB_TMP_PREFIX}manager.watch(${ERLAB_TMP_PREFIX}varname, stop=True, remove=False)`]
		: [`${ERLAB_TMP_PREFIX}manager.watch(${ERLAB_TMP_PREFIX}varname)`];
	const bodyLines = [
		`import erlab.interactive.imagetool.manager as ${ERLAB_TMP_PREFIX}manager`,
		`${ERLAB_TMP_PREFIX}varname = ${JSON.stringify(variableName)}`,
		...applyWatchLines,
	];

	return [
		'import importlib.util',
		`if importlib.util.find_spec("erlab") is not None:`,
		...indentLines(bodyLines, 4),
	].join('\n');
}

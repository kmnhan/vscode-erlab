/**
 * Python magic invocation code builders for erlab IPython magics.
 */

const ERLAB_TMP_PREFIX = '__erlab_tmp__';

/**
 * Build code to invoke an IPython magic with string arguments.
 */
export function buildMagicInvocation(magicName: string, args: string): string {
	return buildMagicInvocationWithArgsCode(magicName, [
		`_args = ${JSON.stringify(args)}`,
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
		...argsLines.map((line) => `        ${line.replace(/^_/, `${ERLAB_TMP_PREFIX}`)}`),
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

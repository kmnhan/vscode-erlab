/**
 * Python code snippet builders for DataArray queries.
 */

const ERLAB_TMP_PREFIX = '__erlab_tmp__';

/**
 * Build Python code to get DataArray info for a variable.
 */
export function buildDataArrayInfoCode(variableName: string): string {
	return [
		'import IPython',
		'import json',
		'try:',
		'    import xarray as xr',
		`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
		`    ${ERLAB_TMP_PREFIX}value = ${variableName}`,
		`    ${ERLAB_TMP_PREFIX}varname = ${JSON.stringify(variableName)}`,
		`    if isinstance(${ERLAB_TMP_PREFIX}value, xr.DataArray):`,
		`        ${ERLAB_TMP_PREFIX}watched = False`,
		'        try:',
		`            ${ERLAB_TMP_PREFIX}magic = ${ERLAB_TMP_PREFIX}ip.find_line_magic("watch") if ${ERLAB_TMP_PREFIX}ip else None`,
		`            ${ERLAB_TMP_PREFIX}owner = getattr(${ERLAB_TMP_PREFIX}magic, "__self__", None)`,
		`            ${ERLAB_TMP_PREFIX}watcher = getattr(${ERLAB_TMP_PREFIX}owner, "_watcher", None)`,
		`            ${ERLAB_TMP_PREFIX}watched = ${ERLAB_TMP_PREFIX}watcher is not None and ${ERLAB_TMP_PREFIX}watcher.watched_vars is not None and ${ERLAB_TMP_PREFIX}varname in ${ERLAB_TMP_PREFIX}watcher.watched_vars`,
		'        except Exception:',
		`            ${ERLAB_TMP_PREFIX}watched = False`,
		`        print(json.dumps({"name": ${ERLAB_TMP_PREFIX}value.name, "dims": list(${ERLAB_TMP_PREFIX}value.dims), "sizes": dict(${ERLAB_TMP_PREFIX}value.sizes), "shape": list(${ERLAB_TMP_PREFIX}value.shape), "dtype": str(${ERLAB_TMP_PREFIX}value.dtype), "ndim": int(${ERLAB_TMP_PREFIX}value.ndim), "watched": ${ERLAB_TMP_PREFIX}watched}))`,
		'    else:',
		'        print(json.dumps(None))',
		`    try:`,
		`        del ${ERLAB_TMP_PREFIX}ip`,
		`        del ${ERLAB_TMP_PREFIX}value`,
		`        del ${ERLAB_TMP_PREFIX}varname`,
		`        del ${ERLAB_TMP_PREFIX}magic`,
		`        del ${ERLAB_TMP_PREFIX}owner`,
		`        del ${ERLAB_TMP_PREFIX}watcher`,
		`        del ${ERLAB_TMP_PREFIX}watched`,
		`    except Exception:`,
		`        pass`,
		`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
		`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
	].join('\n');
}

/**
 * Build Python code to list all DataArrays in the kernel namespace.
 */
export function buildDataArrayListCode(): string {
	return [
		'import IPython',
		'import json',
		'try:',
		'    import xarray as xr',
		`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
		`    ${ERLAB_TMP_PREFIX}user_ns = getattr(${ERLAB_TMP_PREFIX}ip, "user_ns", {}) if ${ERLAB_TMP_PREFIX}ip else {}`,
		`    ${ERLAB_TMP_PREFIX}watcher = None`,
		'    try:',
		`        ${ERLAB_TMP_PREFIX}magic = ${ERLAB_TMP_PREFIX}ip.find_line_magic("watch") if ${ERLAB_TMP_PREFIX}ip else None`,
		`        ${ERLAB_TMP_PREFIX}owner = getattr(${ERLAB_TMP_PREFIX}magic, "__self__", None)`,
		`        ${ERLAB_TMP_PREFIX}watcher = getattr(${ERLAB_TMP_PREFIX}owner, "_watcher", None)`,
		'    except Exception:',
		`        ${ERLAB_TMP_PREFIX}watcher = None`,
		`    ${ERLAB_TMP_PREFIX}watched_vars = set(getattr(${ERLAB_TMP_PREFIX}watcher, "watched_vars", []) or []) if ${ERLAB_TMP_PREFIX}watcher else set()`,
		`    ${ERLAB_TMP_PREFIX}result = []`,
		`    for ${ERLAB_TMP_PREFIX}varname in tuple(${ERLAB_TMP_PREFIX}user_ns.keys()):`,
		`        ${ERLAB_TMP_PREFIX}da = ${ERLAB_TMP_PREFIX}user_ns.get(${ERLAB_TMP_PREFIX}varname, None)`,
		`        if not isinstance(${ERLAB_TMP_PREFIX}da, xr.DataArray) or ${ERLAB_TMP_PREFIX}varname.startswith("_"):`,
		'            continue',
		`        ${ERLAB_TMP_PREFIX}result.append({`,
		`            "variableName": ${ERLAB_TMP_PREFIX}varname,`,
		`            "name": ${ERLAB_TMP_PREFIX}da.name,`,
		`            "dims": list(${ERLAB_TMP_PREFIX}da.dims),`,
		`            "sizes": dict(${ERLAB_TMP_PREFIX}da.sizes),`,
		`            "shape": list(${ERLAB_TMP_PREFIX}da.shape),`,
		`            "dtype": str(${ERLAB_TMP_PREFIX}da.dtype),`,
		`            "ndim": int(${ERLAB_TMP_PREFIX}da.ndim),`,
		`            "watched": ${ERLAB_TMP_PREFIX}varname in ${ERLAB_TMP_PREFIX}watched_vars,`,
		'        })',
		`    print(json.dumps(${ERLAB_TMP_PREFIX}result))`,
		`    try:`,
		`        del ${ERLAB_TMP_PREFIX}ip`,
		`        del ${ERLAB_TMP_PREFIX}user_ns`,
		`        del ${ERLAB_TMP_PREFIX}watcher`,
		`        del ${ERLAB_TMP_PREFIX}magic`,
		`        del ${ERLAB_TMP_PREFIX}owner`,
		`        del ${ERLAB_TMP_PREFIX}watched_vars`,
		`        del ${ERLAB_TMP_PREFIX}result`,
		`        del ${ERLAB_TMP_PREFIX}varname`,
		`        del ${ERLAB_TMP_PREFIX}da`,
		`    except Exception:`,
		`        pass`,
		`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
		`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
	].join('\n');
}

/**
 * Options for configuring xarray display behavior.
 */
export interface XarrayDisplayOptions {
	displayExpandAttrs?: boolean;
	displayExpandCoords?: boolean;
	displayExpandData?: boolean;
}

/**
 * Build Python code to get the HTML representation of a DataArray.
 */
export function buildDataArrayHtmlCode(variableName: string, options?: XarrayDisplayOptions): string {
	const expandAttrs = options?.displayExpandAttrs ?? true;
	const expandCoords = options?.displayExpandCoords ?? true;
	const expandData = options?.displayExpandData ?? false;

	return [
		'import IPython',
		'import json',
		'try:',
		'    import xarray as xr',
		`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
		`    ${ERLAB_TMP_PREFIX}value = ${variableName}`,
		`    if isinstance(${ERLAB_TMP_PREFIX}value, xr.DataArray):`,
		`        with xr.set_options(display_expand_attrs=${expandAttrs ? 'True' : 'False'}, display_expand_coords=${expandCoords ? 'True' : 'False'}, display_expand_data=${expandData ? 'True' : 'False'}):`,
		`            ${ERLAB_TMP_PREFIX}html = ${ERLAB_TMP_PREFIX}value._repr_html_()`,
		`        print(json.dumps({"html": ${ERLAB_TMP_PREFIX}html}))`,
		'    else:',
		'        print(json.dumps({"html": None}))',
		`    try:`,
		`        del ${ERLAB_TMP_PREFIX}ip`,
		`        del ${ERLAB_TMP_PREFIX}value`,
		`        del ${ERLAB_TMP_PREFIX}html`,
		`    except Exception:`,
		`        pass`,
		`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
		`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
	].join('\n');
}

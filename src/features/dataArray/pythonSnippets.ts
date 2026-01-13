/**
 * Python code snippet builders for DataArray queries.
 */

const ERLAB_TMP_PREFIX = '__erlab_tmp__';

/**
 * Indent a multiline string by a specified number of spaces.
 */
function indent(code: string, spaces: number): string {
	const prefix = ' '.repeat(spaces);
	return code.split('\n').map(line => prefix + line).join('\n');
}

/**
 * Common Python code for extracting DataArray info.
 * This helper is called within the generated code for each variable.
 */
const EXTRACT_INFO_HELPER = `def ${ERLAB_TMP_PREFIX}extract_info(varname, da, watched_vars):
    return {
        "variableName": varname,
        "name": da.name,
        "dims": list(da.dims),
        "sizes": dict(da.sizes),
        "shape": list(da.shape),
        "dtype": str(da.dtype),
        "ndim": int(da.ndim),
        "watched": varname in watched_vars,
    }`;

/**
 * Common Python code for getting the watched variables set.
 */
const GET_WATCHED_VARS_CODE = `${ERLAB_TMP_PREFIX}watched_vars = set()
try:
    ${ERLAB_TMP_PREFIX}magic = ${ERLAB_TMP_PREFIX}ip.find_line_magic("watch") if ${ERLAB_TMP_PREFIX}ip else None
    ${ERLAB_TMP_PREFIX}owner = getattr(${ERLAB_TMP_PREFIX}magic, "__self__", None)
    ${ERLAB_TMP_PREFIX}watcher = getattr(${ERLAB_TMP_PREFIX}owner, "_watcher", None)
    ${ERLAB_TMP_PREFIX}watched_vars = set(getattr(${ERLAB_TMP_PREFIX}watcher, "watched_vars", []) or []) if ${ERLAB_TMP_PREFIX}watcher else set()
except Exception:
    ${ERLAB_TMP_PREFIX}watched_vars = set()`;

/**
 * Build Python code to query DataArray info.
 * If variableName is provided, queries a single variable.
 * If variableName is omitted, queries all DataArrays in the namespace.
 * Both modes return an array of DataArrayEntry objects with variableName included.
 */
export function buildDataArrayQueryCode(variableName?: string): string {
	if (variableName) {
		// Single variable mode: returns array with 0 or 1 entry
		return [
			'import IPython',
			'import json',
			'try:',
			'    import xarray as xr',
			`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
			indent(EXTRACT_INFO_HELPER, 4),
			indent(GET_WATCHED_VARS_CODE, 4),
			`    ${ERLAB_TMP_PREFIX}value = ${variableName}`,
			`    ${ERLAB_TMP_PREFIX}varname = ${JSON.stringify(variableName)}`,
			`    if isinstance(${ERLAB_TMP_PREFIX}value, xr.DataArray):`,
			`        print(json.dumps([${ERLAB_TMP_PREFIX}extract_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}value, ${ERLAB_TMP_PREFIX}watched_vars)]))`,
			'    else:',
			'        print(json.dumps([]))',
			`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
			`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
		].join('\n');
	} else {
		// Namespace scan mode: returns array of all DataArrays
		return [
			'import IPython',
			'import json',
			'try:',
			'    import xarray as xr',
			`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
			`    ${ERLAB_TMP_PREFIX}user_ns = getattr(${ERLAB_TMP_PREFIX}ip, "user_ns", {}) if ${ERLAB_TMP_PREFIX}ip else {}`,
			indent(EXTRACT_INFO_HELPER, 4),
			indent(GET_WATCHED_VARS_CODE, 4),
			`    ${ERLAB_TMP_PREFIX}result = []`,
			`    for ${ERLAB_TMP_PREFIX}varname in tuple(${ERLAB_TMP_PREFIX}user_ns.keys()):`,
			`        ${ERLAB_TMP_PREFIX}da = ${ERLAB_TMP_PREFIX}user_ns.get(${ERLAB_TMP_PREFIX}varname, None)`,
			`        if not isinstance(${ERLAB_TMP_PREFIX}da, xr.DataArray) or ${ERLAB_TMP_PREFIX}varname.startswith("_"):`,
			'            continue',
			`        ${ERLAB_TMP_PREFIX}result.append(${ERLAB_TMP_PREFIX}extract_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}da, ${ERLAB_TMP_PREFIX}watched_vars))`,
			`    print(json.dumps(${ERLAB_TMP_PREFIX}result))`,
			`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
			`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
		].join('\n');
	}
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

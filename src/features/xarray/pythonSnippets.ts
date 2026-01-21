/**
 * Python code snippet builders for xarray object queries.
 */

import type { XarrayObjectType } from './types';

const ERLAB_TMP_PREFIX = '__erlab_tmp__';

/**
 * Indent a multiline string by a specified number of spaces.
 */
function indent(code: string, spaces: number): string {
	const prefix = ' '.repeat(spaces);
	return code.split('\n').map(line => prefix + line).join('\n');
}

/**
 * Common Python code for extracting DataArray info (summary, no dims/shape).
 * This helper is called within the generated code for each DataArray variable.
 */
const EXTRACT_DATAARRAY_SUMMARY_HELPER = `def ${ERLAB_TMP_PREFIX}extract_dataarray_summary(varname, da, watched_vars):
    return {
        "variableName": varname,
        "type": "DataArray",
        "name": da.name,
        "watched": varname in watched_vars,
    }`;

/**
 * Common Python code for extracting full DataArray info.
 * This helper is called within the generated code for each DataArray variable.
 */
const EXTRACT_DATAARRAY_INFO_HELPER = `def ${ERLAB_TMP_PREFIX}extract_dataarray_info(varname, da, watched_vars):
    return {
        "variableName": varname,
        "type": "DataArray",
        "name": da.name,
        "dims": list(da.dims),
        "sizes": dict(da.sizes),
        "shape": list(da.shape),
        "dtype": str(da.dtype),
        "ndim": int(da.ndim),
        "watched": varname in watched_vars,
    }`;

/**
 * Common Python code for extracting Dataset info.
 */
const EXTRACT_DATASET_INFO_HELPER = `def ${ERLAB_TMP_PREFIX}extract_dataset_info(varname, ds):
    return {
        "variableName": varname,
        "type": "Dataset",
        "name": None,
    }`;

/**
 * Common Python code for extracting DataTree info.
 */
const EXTRACT_DATATREE_INFO_HELPER = `def ${ERLAB_TMP_PREFIX}extract_datatree_info(varname, dt):
    return {
        "variableName": varname,
        "type": "DataTree",
        "name": None,
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
 * Build Python code to query xarray object info.
 * If variableName is provided, queries a single variable.
 * If variableName is omitted, queries all xarray objects (DataArray, Dataset, DataTree) in the namespace.
 * Both modes return an array of XarrayEntry objects with variableName and type included.
 */
export interface XarrayQueryOptions {
	includeDataArrayDetails?: boolean;
}

export function buildXarrayQueryCode(variableName?: string, options?: XarrayQueryOptions): string {
	const includeDetails = options?.includeDataArrayDetails ?? Boolean(variableName);
	const dataArrayHelper = includeDetails ? EXTRACT_DATAARRAY_INFO_HELPER : EXTRACT_DATAARRAY_SUMMARY_HELPER;
	const dataArrayExtractor = includeDetails
		? `${ERLAB_TMP_PREFIX}extract_dataarray_info`
		: `${ERLAB_TMP_PREFIX}extract_dataarray_summary`;

	if (variableName) {
		// Single variable mode: returns array with 0 or 1 entry
		return [
			'import IPython',
			'import json',
			'try:',
			'    import xarray as xr',
			`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
			indent(dataArrayHelper, 4),
			indent(EXTRACT_DATASET_INFO_HELPER, 4),
			indent(EXTRACT_DATATREE_INFO_HELPER, 4),
			indent(GET_WATCHED_VARS_CODE, 4),
			`    ${ERLAB_TMP_PREFIX}value = ${variableName}`,
			`    ${ERLAB_TMP_PREFIX}varname = ${JSON.stringify(variableName)}`,
			`    if isinstance(${ERLAB_TMP_PREFIX}value, xr.DataArray):`,
			`        print(json.dumps([${dataArrayExtractor}(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}value, ${ERLAB_TMP_PREFIX}watched_vars)]))`,
			`    elif isinstance(${ERLAB_TMP_PREFIX}value, xr.Dataset):`,
			`        print(json.dumps([${ERLAB_TMP_PREFIX}extract_dataset_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}value)]))`,
			`    elif hasattr(xr, 'DataTree') and isinstance(${ERLAB_TMP_PREFIX}value, xr.DataTree):`,
			`        print(json.dumps([${ERLAB_TMP_PREFIX}extract_datatree_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}value)]))`,
			'    else:',
			'        print(json.dumps([]))',
			`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
			`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
		].join('\n');
	} else {
		// Namespace scan mode: returns array of all xarray objects
		return [
			'import IPython',
			'import json',
			'try:',
			'    import xarray as xr',
			`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
			`    ${ERLAB_TMP_PREFIX}user_ns = getattr(${ERLAB_TMP_PREFIX}ip, "user_ns", {}) if ${ERLAB_TMP_PREFIX}ip else {}`,
			indent(dataArrayHelper, 4),
			indent(EXTRACT_DATASET_INFO_HELPER, 4),
			indent(EXTRACT_DATATREE_INFO_HELPER, 4),
			indent(GET_WATCHED_VARS_CODE, 4),
			`    ${ERLAB_TMP_PREFIX}has_datatree = hasattr(xr, 'DataTree')`,
			`    ${ERLAB_TMP_PREFIX}result = []`,
			`    for ${ERLAB_TMP_PREFIX}varname in tuple(${ERLAB_TMP_PREFIX}user_ns.keys()):`,
			`        if ${ERLAB_TMP_PREFIX}varname.startswith("_"):`,
			'            continue',
			`        ${ERLAB_TMP_PREFIX}obj = ${ERLAB_TMP_PREFIX}user_ns.get(${ERLAB_TMP_PREFIX}varname, None)`,
			`        if isinstance(${ERLAB_TMP_PREFIX}obj, xr.DataArray):`,
			`            ${ERLAB_TMP_PREFIX}result.append(${dataArrayExtractor}(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}obj, ${ERLAB_TMP_PREFIX}watched_vars))`,
			`        elif isinstance(${ERLAB_TMP_PREFIX}obj, xr.Dataset):`,
			`            ${ERLAB_TMP_PREFIX}result.append(${ERLAB_TMP_PREFIX}extract_dataset_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}obj))`,
			`        elif ${ERLAB_TMP_PREFIX}has_datatree and isinstance(${ERLAB_TMP_PREFIX}obj, xr.DataTree):`,
			`            ${ERLAB_TMP_PREFIX}result.append(${ERLAB_TMP_PREFIX}extract_datatree_info(${ERLAB_TMP_PREFIX}varname, ${ERLAB_TMP_PREFIX}obj))`,
			`    print(json.dumps(${ERLAB_TMP_PREFIX}result))`,
			`except Exception as ${ERLAB_TMP_PREFIX}exc:`,
			`    print(json.dumps({"error": str(${ERLAB_TMP_PREFIX}exc)}))`,
		].join('\n');
	}
}

/**
 * @deprecated Use buildXarrayQueryCode instead
 */
export const buildDataArrayQueryCode = buildXarrayQueryCode;

/**
 * Options for configuring xarray display behavior.
 */
export interface XarrayDisplayOptions {
	displayExpandAttrs?: boolean;
	displayExpandCoords?: boolean;
	displayExpandData?: boolean;
}

/**
 * Build Python code to get the HTML representation of an xarray object (DataArray, Dataset, or DataTree).
 */
export function buildXarrayHtmlCode(variableName: string, options?: XarrayDisplayOptions): string {
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
		`    ${ERLAB_TMP_PREFIX}has_datatree = hasattr(xr, 'DataTree')`,
		`    if isinstance(${ERLAB_TMP_PREFIX}value, (xr.DataArray, xr.Dataset)) or (${ERLAB_TMP_PREFIX}has_datatree and isinstance(${ERLAB_TMP_PREFIX}value, xr.DataTree)):`,
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

/**
 * @deprecated Use buildXarrayHtmlCode instead
 */
export const buildDataArrayHtmlCode = buildXarrayHtmlCode;

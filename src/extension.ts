// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { TextDecoder } from 'util';

type MagicCommandArgs = { variableName?: string };
type DataArrayInfo = {
	name?: string;
	dims: string[];
	sizes: Record<string, number>;
	watched?: boolean;
};
type DataArrayInfoCacheEntry = { value?: DataArrayInfo; timestamp: number };
type KernelOutputItem = { mime: string; data: Uint8Array };
type KernelOutput = { items: KernelOutputItem[]; metadata?: Record<string, unknown> };
type KernelLike = {
	executeCode: (code: string, token: vscode.CancellationToken) => AsyncIterable<KernelOutput>;
};
type JupyterApi = {
	kernels?: {
		getKernel: (uri: vscode.Uri) => Thenable<KernelLike | undefined>;
	};
};

const DATA_ARRAY_CONTEXT = 'erlab.isDataArray';
const DATA_ARRAY_WATCHED_CONTEXT = 'erlab.isDataArrayWatched';
const DATA_ARRAY_INFO_TTL_MS = 3000;
const textDecoder = new TextDecoder();
const dataArrayInfoCache = new Map<string, DataArrayInfoCacheEntry>();

const PYTHON_KEYWORDS = new Set([
	'false', 'none', 'true',
	'and', 'as', 'assert', 'async', 'await',
	'break', 'class', 'continue', 'def', 'del',
	'elif', 'else', 'except', 'finally', 'for',
	'from', 'global', 'if', 'import', 'in',
	'is', 'lambda', 'nonlocal', 'not', 'or',
	'pass', 'raise', 'return', 'try', 'while',
	'with', 'yield',
]);

const PYTHON_BUILTINS = new Set([
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

const PYTHON_MAGIC_VARS = new Set([
	'__annotations__', '__builtins__', '__cached__', '__doc__', '__file__',
	'__loader__', '__name__', '__package__', '__spec__',
]);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('erlab extension activated');

	const registerMagicCommand = (
		commandId: string,
		magicName: string,
		buildArgs: (variableName: string) => string
	): vscode.Disposable => vscode.commands.registerCommand(commandId, async (args?: MagicCommandArgs) => {
		try {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !isNotebookCellDocument(editor.document)) {
				vscode.window.showInformationMessage('erlab: open a Python notebook cell to run the magic.');
				return;
			}

			const variableName = args?.variableName ?? getVariableAtSelection(editor);
			if (!variableName) {
				vscode.window.showInformationMessage('erlab: place the cursor on a variable name.');
				return;
			}

			await vscode.commands.executeCommand('editor.action.hideHover');
			const notebookUri = getNotebookUriForDocument(editor.document);
			const code = buildMagicInvocation(magicName, buildArgs(variableName));
			const output = await executeInKernel(notebookUri, code);
			showMagicOutput(output);
			invalidateDataArrayInfoCache(editor.document, variableName);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`erlab: ${message}`);
		}
	});

	const watchDisposable = registerMagicCommand(
		'erlab.watch',
		'watch',
		(variableName) => variableName
	);

	const itoolDisposable = registerMagicCommand(
		'erlab.itool',
		'itool',
		(variableName) => {
			const useManager = vscode.workspace.getConfiguration('erlab').get<boolean>('itool.useManager', true);
			return useManager ? `-m ${variableName}` : variableName;
		}
	);

	const unwatchDisposable = registerMagicCommand(
		'erlab.unwatch',
		'watch',
		(variableName) => `-d ${variableName}`
	);

	const hoverDisposable = vscode.languages.registerHoverProvider({ language: 'python' }, {
		provideHover: async (document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> => {
			if (!isNotebookCellDocument(document)) {
				return;
			}

			const range = document.getWordRangeAtPosition(position);
			if (!range) {
				return;
			}

			const variableName = document.getText(range);
			if (!isValidPythonIdentifier(variableName)) {
				return;
			}
			const info = await getDataArrayInfo(document, variableName);
			if (!info) {
				return;
			}

			const md = new vscode.MarkdownString();
			md.supportThemeIcons = true;
			const label = formatDataArrayLabel(info, variableName);
			md.appendMarkdown(`${label}\n\n`);
			if (info.watched) {
				md.appendMarkdown(
					`[$(eye) Show](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(eye-closed) Unwatch](command:erlab.unwatch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(open-preview) ImageTool](command:erlab.itool?${encodeCommandArgs({ variableName })})\n`
				);
			} else {
				md.appendMarkdown(
					`[$(eye) Watch](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(open-preview) ImageTool](command:erlab.itool?${encodeCommandArgs({ variableName })})\n`
				);
			}
			md.isTrusted = true;

			return new vscode.Hover(md, range);
		}
	});

	const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(async (event: vscode.TextEditorSelectionChangeEvent) => {
		if (!event.textEditor || !isNotebookCellDocument(event.textEditor.document)) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			return;
		}

		const variableName = getVariableAtSelection(event.textEditor);
		if (!variableName || !isValidPythonIdentifier(variableName)) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
			return;
		}

		const position = event.selections[0].active;
		const range = event.textEditor.document.getWordRangeAtPosition(position);
		if (!range) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			return;
		}
		const selectedVariable = event.textEditor.document.getText(range);
		if (!isValidPythonIdentifier(selectedVariable)) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
			return;
		}
		const info = await getDataArrayInfo(event.textEditor.document, selectedVariable);
		const isDataArray = Boolean(info);
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, isDataArray);
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, Boolean(info?.watched));
	});

	const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor?: vscode.TextEditor) => {
		if (!editor || !isNotebookCellDocument(editor.document)) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
		}
	});

	const notebookCellStatusBarDisposable = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
		'jupyter-notebook',
		{
			provideCellStatusBarItems: async (
				cell: vscode.NotebookCell,
				token: vscode.CancellationToken
			): Promise<vscode.NotebookCellStatusBarItem[]> => {
				if (cell.document.languageId !== 'python') {
					return [];
				}

				const variableName = getLastLineVariable(cell.document);
				if (!variableName || !isValidPythonIdentifier(variableName)) {
					return [];
				}

				const info = await getDataArrayInfo(cell.document, variableName);
				if (token.isCancellationRequested || !info) {
					return [];
				}

				const label = `Open '${variableName}' in ImageTool`;
				const item = new vscode.NotebookCellStatusBarItem(
					label,
					vscode.NotebookCellStatusBarAlignment.Left
				);
				item.command = {
					command: 'erlab.itool',
					title: 'Open in ImageTool',
					arguments: [{ variableName }]
				};
				item.tooltip = label;
				return [item];
			}
		}
	);

	context.subscriptions.push(
		watchDisposable,
		itoolDisposable,
		unwatchDisposable,
		hoverDisposable,
		selectionDisposable,
		activeEditorDisposable,
		notebookCellStatusBarDisposable
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }

function isNotebookCellDocument(document: vscode.TextDocument): boolean {
	return document.uri.scheme === 'vscode-notebook-cell';
}

function getVariableAtSelection(editor: vscode.TextEditor): string | undefined {
	const position = editor.selection.active;
	const range = editor.document.getWordRangeAtPosition(position);
	if (!range) {
		return;
	}
	return editor.document.getText(range);
}

function getLastLineVariable(document: vscode.TextDocument): string | undefined {
	for (let lineIndex = document.lineCount - 1; lineIndex >= 0; lineIndex -= 1) {
		const text = document.lineAt(lineIndex).text.trim();
		if (!text) {
			continue;
		}
		return text;
	}
	return;
}

function encodeCommandArgs(args: Record<string, unknown>): string {
	return encodeURIComponent(JSON.stringify(args));
}

function isValidPythonIdentifier(value: string): boolean {
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

function isDunderName(value: string): boolean {
	return value.length > 4 && value.startsWith('__') && value.endsWith('__');
}

function formatDataArrayLabel(info: DataArrayInfo, fallbackName: string): string {
	const name = info.name ?? fallbackName;
	const dims = formatDimsWithSizes(info.dims, info.sizes);
	if (!dims) {
		return name;
	}
	return `${name} (${dims})`;
}

function formatDimsWithSizes(dims: string[], sizes: Record<string, number>): string {
	if (dims.length === 0) {
		return '';
	}
	return dims
		.map((dim) => `${dim}: ${sizes[dim] ?? '?'}`)
		.join(', ');
}

function buildMagicInvocation(magicName: string, args: string): string {
	return [
		'import importlib.util',
		'import IPython',
		`if importlib.util.find_spec("erlab") is not None:`,
		'    _ip = IPython.get_ipython()',
		'    if _ip and "erlab.interactive" not in _ip.extension_manager.loaded:',
		'        _ip.run_line_magic("load_ext", "erlab.interactive")',
		'    if _ip:',
		`        _ip.run_line_magic(${JSON.stringify(magicName)}, ${JSON.stringify(args)})`,
	].join('\n');
}

function buildDataArrayInfoCode(variableName: string): string {
	return [
		'import importlib.util',
		'import IPython',
		'import json',
		'try:',
		'    if importlib.util.find_spec("erlab") is None:',
		'        print(json.dumps(None))',
		'    else:',
		'        import xarray as xr',
		'        _ip = IPython.get_ipython()',
		'        if _ip and "erlab.interactive" not in _ip.extension_manager.loaded:',
		'            _ip.run_line_magic("load_ext", "erlab.interactive")',
		`        _erlab_value = ${variableName}`,
		`        _varname = ${JSON.stringify(variableName)}`,
		'        if isinstance(_erlab_value, xr.DataArray):',
		'            _watched = False',
		'            try:',
		'                _magic = _ip.find_line_magic("watch") if _ip else None',
		'                _owner = getattr(_magic, "__self__", None)',
		'                _watcher = getattr(_owner, "_watcher", None)',
		'                _watched = _watcher is not None and _watcher.watched_vars is not None and _varname in _watcher.watched_vars',
		'            except Exception:',
		'                _watched = False',
		'            print(json.dumps({"name": _erlab_value.name, "dims": list(_erlab_value.dims), "sizes": dict(_erlab_value.sizes), "watched": _watched}))',
		'        else:',
		'            print(json.dumps(None))',
		'except Exception as _erlab_exc:',
		'    print(json.dumps({"error": str(_erlab_exc)}))',
	].join('\n');
}

async function getDataArrayInfo(
	document: vscode.TextDocument,
	variableName: string
): Promise<DataArrayInfo | undefined> {
	const notebookUri = getNotebookUriForDocument(document);
	if (!notebookUri) {
		return;
	}

	const cacheKey = getDataArrayInfoCacheKey(notebookUri, variableName);
	const cached = dataArrayInfoCache.get(cacheKey);
	if (cached && Date.now() - cached.timestamp < DATA_ARRAY_INFO_TTL_MS) {
		return cached.value;
	}

	try {
		const output = await executeInKernelForOutput(
			notebookUri,
			buildDataArrayInfoCode(variableName)
		);
		const line = extractLastJsonLine(output);
		if (!line) {
			dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
			return;
		}

		const parsed = JSON.parse(line) as {
			name?: string | null;
			dims?: string[];
			sizes?: Record<string, number>;
			watched?: boolean;
			error?: string;
		} | null;
		if (!parsed || parsed.error || !parsed.dims || !parsed.sizes) {
			dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
			return;
		}

		const info: DataArrayInfo = {
			name: parsed.name ?? undefined,
			dims: parsed.dims,
			sizes: parsed.sizes,
			watched: parsed.watched ?? false,
		};
		dataArrayInfoCache.set(cacheKey, { value: info, timestamp: Date.now() });
		return info;
	} catch {
		dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
		return;
	}
}

function invalidateDataArrayInfoCache(document: vscode.TextDocument, variableName: string): void {
	const notebookUri = getNotebookUriForDocument(document);
	if (!notebookUri) {
		return;
	}
	dataArrayInfoCache.delete(getDataArrayInfoCacheKey(notebookUri, variableName));
}

function getDataArrayInfoCacheKey(notebookUri: vscode.Uri, variableName: string): string {
	return `${notebookUri.toString()}::${variableName}`;
}

async function executeInKernel(notebookUri: vscode.Uri | undefined, code: string): Promise<string> {
	if (!notebookUri) {
		vscode.window.showInformationMessage('erlab: open a notebook to run the magic.');
		return '';
	}

	const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
	if (!jupyterExtension) {
		vscode.window.showInformationMessage('erlab: Jupyter extension not found.');
		return '';
	}

	const activatedApi = await jupyterExtension.activate() as JupyterApi | undefined;
	const jupyterApi = (jupyterExtension.exports ?? activatedApi) as JupyterApi | undefined;
	if (!jupyterApi?.kernels || typeof jupyterApi.kernels.getKernel !== 'function') {
		vscode.window.showInformationMessage('erlab: Jupyter kernel API not available.');
		return '';
	}

	const kernel = await jupyterApi.kernels.getKernel(notebookUri);
	if (!kernel || typeof kernel.executeCode !== 'function') {
		vscode.window.showInformationMessage('erlab: no active kernel for this notebook.');
		return '';
	}

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stdoutMime = vscode.NotebookCellOutputItem.stdout('').mime;
	const textPlainMime = 'text/plain';
	const chunks: string[] = [];
	const errors: string[] = [];
	try {
		for await (const output of kernel.executeCode(code, tokenSource.token)) {
			for (const item of output.items) {
				if (item.mime === errorMime) {
					const decoded = textDecoder.decode(item.data);
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					chunks.push(textDecoder.decode(item.data));
				}
			}
		}
	} finally {
		tokenSource.dispose();
	}

	if (errors.length > 0) {
		throw new Error(errors.map((err) => err.trim()).filter(Boolean).join('; '));
	}

	return chunks.join('');
}

async function executeInKernelForOutput(
	notebookUri: vscode.Uri,
	code: string
): Promise<string> {
	const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
	if (!jupyterExtension) {
		throw new Error('Jupyter extension not found.');
	}

	const activatedApi = await jupyterExtension.activate() as JupyterApi | undefined;
	const jupyterApi = (jupyterExtension.exports ?? activatedApi) as JupyterApi | undefined;
	if (!jupyterApi?.kernels || typeof jupyterApi.kernels.getKernel !== 'function') {
		throw new Error('Jupyter kernel API not available.');
	}

	const kernel = await jupyterApi.kernels.getKernel(notebookUri);
	if (!kernel || typeof kernel.executeCode !== 'function') {
		throw new Error('No active kernel for this notebook.');
	}

	const tokenSource = new vscode.CancellationTokenSource();
	const errorMime = vscode.NotebookCellOutputItem.error(new Error('')).mime;
	const stdoutMime = vscode.NotebookCellOutputItem.stdout('').mime;
	const textPlainMime = 'text/plain';
	const chunks: string[] = [];
	const errors: string[] = [];
	try {
		for await (const output of kernel.executeCode(code, tokenSource.token)) {
			for (const item of output.items) {
				if (item.mime === errorMime) {
					const decoded = textDecoder.decode(item.data);
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					chunks.push(textDecoder.decode(item.data));
				}
			}
		}
	} finally {
		tokenSource.dispose();
	}

	if (errors.length > 0) {
		throw new Error(errors.map((err) => err.trim()).filter(Boolean).join('; '));
	}

	return chunks.join('');
}

function extractLastJsonLine(output: string): string | undefined {
	const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (line.startsWith('{') || line === 'null') {
			return line;
		}
	}
	return;
}

function normalizeKernelError(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as { name?: string; message?: string; stack?: string };
		if (parsed?.message) {
			return parsed.name ? `${parsed.name}: ${parsed.message}` : parsed.message;
		}
	} catch {
		// Fall back to raw.
	}
	return raw;
}

function showMagicOutput(output: string): void {
	const trimmed = output.trim();
	if (!trimmed) {
		return;
	}
	const normalized = trimmed.replace(/\r?\n+/g, ' | ');
	const message = normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
	vscode.window.setStatusBarMessage(`erlab: ${message}`, 2500);
}

function getNotebookUriForDocument(document: vscode.TextDocument): vscode.Uri | undefined {
	for (const notebook of vscode.workspace.notebookDocuments) {
		for (const cell of notebook.getCells()) {
			if (cell.document.uri.toString() === document.uri.toString()) {
				return notebook.uri;
			}
		}
	}
	return;
}

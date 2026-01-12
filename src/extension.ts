// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { TextDecoder } from 'util';

type MagicCommandArgs = { variableName?: string };
type DataArrayInfo = {
	name?: string;
	dims: string[];
	sizes: Record<string, number>;
	shape: number[];
	dtype: string;
	ndim: number;
	watched?: boolean;
};
type DataArrayInfoCacheEntry = { value?: DataArrayInfo; timestamp: number };
type KernelOutputItem = { mime: string; data: unknown };
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
const PINNED_DATAARRAYS_KEY = 'erlab.pinnedDataArrays';
const ERLAB_TMP_PREFIX = '__erlab_tmp__';
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
		buildArgs: (variableName: string) => string,
		buildMagicCode?: (variableName: string) => string,
		onDidExecute?: (variableName: string, document: vscode.TextDocument) => void | Promise<void>
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
			const code = buildMagicCode
				? buildMagicCode(variableName)
				: buildMagicInvocation(magicName, buildArgs(variableName));
			const output = await executeInKernel(notebookUri, code);
			showMagicOutput(output);
			invalidateDataArrayInfoCache(editor.document, variableName);
			if (onDidExecute) {
				await onDidExecute(variableName, editor.document);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`erlab: ${message}`);
		}
	});

	const pinnedStore = new PinnedDataArrayStore(context.globalState);
	const dataArrayPanelProvider = new DataArrayPanelProvider(pinnedStore);
	const dataArrayTreeView = vscode.window.createTreeView('erlabDataArrays', {
		treeDataProvider: dataArrayPanelProvider,
		showCollapseAll: false,
	});
	dataArrayPanelProvider.setTreeView(dataArrayTreeView);
	const dataArrayDetailProvider = new DataArrayDetailViewProvider();
	const dataArrayDetailDisposable = vscode.window.registerWebviewViewProvider(
		'erlabDataArrayDetail',
		dataArrayDetailProvider
	);
	const requestDataArrayRefresh = (): void => {
		dataArrayPanelProvider.requestRefresh();
	};
	const dataArrayVisibilityDisposable = dataArrayTreeView.onDidChangeVisibility(() => {
		requestDataArrayRefresh();
	});

	const watchDisposable = registerMagicCommand(
		'erlab.watch',
		'watch',
		(variableName) => variableName,
		undefined,
		() => requestDataArrayRefresh()
	);

	const itoolDisposable = registerMagicCommand(
		'erlab.itool',
		'itool',
		(variableName) => variableName,
		(variableName) => {
			const useManager = vscode.workspace.getConfiguration('erlab').get<boolean>('itool.useManager', true);
			return buildItoolInvocation(variableName, useManager);
		},
		() => requestDataArrayRefresh()
	);

	const unwatchDisposable = registerMagicCommand(
		'erlab.unwatch',
		'watch',
		(variableName) => `-d ${variableName}`,
		undefined,
		() => requestDataArrayRefresh()
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
			const notebookUri = getNotebookUriForDocument(document);
			const isPinned = notebookUri
				? pinnedStore.isPinned(notebookUri, variableName)
				: false;
			const hoverArgs = encodeCommandArgs({
				variableName,
				ndim: info.ndim,
				notebookUri: notebookUri?.toString(),
			});
			if (info.watched) {
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.dataArray.openDetail?${hoverArgs}) | ` +
					`[$(eye) Show](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(eye-closed) Unwatch](command:erlab.unwatch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(empty-window) ImageTool](command:erlab.dataArray.openInImageTool?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.dataArray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n`
				);
			} else {
				md.appendMarkdown(
					`[$(list-flat) Details](command:erlab.dataArray.openDetail?${hoverArgs}) | ` +
					`[$(eye) Watch](command:erlab.watch?${encodeCommandArgs({ variableName })}) | ` +
					`[$(empty-window) ImageTool](command:erlab.dataArray.openInImageTool?${hoverArgs}) | ` +
					`[$(pin) ${isPinned ? 'Unpin' : 'Pin'}](command:erlab.dataArray.togglePin?${encodeCommandArgs({ variableName, reveal: !isPinned })})\n`
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
			requestDataArrayRefresh();
			return;
		}
		requestDataArrayRefresh();
	});

	const activeNotebookDisposable = vscode.window.onDidChangeActiveNotebookEditor(() => {
		requestDataArrayRefresh();
	});

	const notebookExecutionDisposable = vscode.workspace.onDidChangeNotebookDocument((event) => {
		const activeNotebook = getActiveNotebookUri();
		if (!activeNotebook) {
			return;
		}
		if (event.notebook.uri.toString() !== activeNotebook.toString()) {
			return;
		}
		const hasExecutionSummary = event.cellChanges.some((change) => change.executionSummary);
		const hasOutputsChange = event.cellChanges.some((change) => change.outputs);
		if (hasOutputsChange && !hasExecutionSummary) {
			dataArrayPanelProvider.setExecutionInProgress(true);
			dataArrayDetailProvider.setExecutionInProgress(true);
			return;
		}
		if (hasExecutionSummary) {
			dataArrayPanelProvider.setExecutionInProgress(false);
			dataArrayDetailProvider.setExecutionInProgress(false);
			requestDataArrayRefresh();
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

				const label = `$(empty-window) Open '${variableName}' in ImageTool`;
				const item = new vscode.NotebookCellStatusBarItem(
					label,
					vscode.NotebookCellStatusBarAlignment.Left
				);
				item.priority = 1000;
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

	const refreshDataArrayPanelDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.refresh',
		() => requestDataArrayRefresh()
	);

	const openDataArrayDetailDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.openDetail',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to view DataArrays.');
				return;
			}
			await dataArrayDetailProvider.showDetail(notebookUri, variableName);
		}
	);

	const togglePinDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.togglePin',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to pin DataArrays.');
				return;
			}
			await vscode.commands.executeCommand('editor.action.hideHover');
			const isPinned = pinnedStore.isPinned(notebookUri, variableName);
			if (isPinned) {
				await pinnedStore.unpin(notebookUri, variableName);
			} else {
				await pinnedStore.pin(notebookUri, variableName);
			}
			requestDataArrayRefresh();
			if (!isPinned && normalized?.reveal) {
				await vscode.commands.executeCommand('workbench.view.extension.erlab');
				await dataArrayPanelProvider.reveal(variableName);
			}
		}
	);

	const pinDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.pin',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to pin DataArrays.');
				return;
			}
			if (!pinnedStore.isPinned(notebookUri, variableName)) {
				await pinnedStore.pin(notebookUri, variableName);
				requestDataArrayRefresh();
			}
		}
	);

	const unpinDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.unpin',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to unpin DataArrays.');
				return;
			}
			if (pinnedStore.isPinned(notebookUri, variableName)) {
				await pinnedStore.unpin(notebookUri, variableName);
				requestDataArrayRefresh();
			}
		}
	);

	const toggleWatchDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.toggleWatch',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to watch DataArrays.');
				return;
			}
			const watched = Boolean(normalized?.watched);
			await vscode.commands.executeCommand(watched ? 'erlab.unwatch' : 'erlab.watch', { variableName });
			requestDataArrayRefresh();
		}
	);

	const dataArrayWatchDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.watch',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			await vscode.commands.executeCommand('erlab.watch', { variableName });
			requestDataArrayRefresh();
		}
	);

	const dataArrayUnwatchDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.unwatch',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			await vscode.commands.executeCommand('erlab.unwatch', { variableName });
			requestDataArrayRefresh();
		}
	);

	const openInImageToolDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.openInImageTool',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			if (typeof normalized?.ndim === 'number' && normalized.ndim >= 5) {
				vscode.window.showInformationMessage('erlab: ImageTool supports DataArrays with ndim < 5.');
				return;
			}
			await vscode.commands.executeCommand('erlab.itool', { variableName });
		}
	);

	const goToDefinitionDisposable = vscode.commands.registerCommand(
		'erlab.dataArray.goToDefinition',
		async (args?: DataArrayPanelCommandArgs) => {
			const normalized = normalizeDataArrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to navigate to definitions.');
				return;
			}
			const notebook = vscode.workspace.notebookDocuments.find(
				(doc) => doc.uri.toString() === notebookUri.toString()
			);
			if (!notebook) {
				vscode.window.showInformationMessage('erlab: active notebook not found.');
				return;
			}
			const target = await findNotebookDefinitionLocation(notebook, variableName);
			if (!target) {
				vscode.window.showInformationMessage(`erlab: no definition found for ${variableName}.`);
				return;
			}
			const editor = await vscode.window.showTextDocument(target.document, {
				selection: target.range,
				preview: true,
			});
			editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
		}
	);

	context.subscriptions.push(
		watchDisposable,
		itoolDisposable,
		unwatchDisposable,
		hoverDisposable,
		selectionDisposable,
		activeEditorDisposable,
		activeNotebookDisposable,
		notebookExecutionDisposable,
		notebookCellStatusBarDisposable,
		refreshDataArrayPanelDisposable,
		openDataArrayDetailDisposable,
		togglePinDisposable,
		pinDisposable,
		unpinDisposable,
		toggleWatchDisposable,
		dataArrayWatchDisposable,
		dataArrayUnwatchDisposable,
		openInImageToolDisposable,
		goToDefinitionDisposable,
		dataArrayTreeView,
		dataArrayDetailDisposable,
		dataArrayVisibilityDisposable
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
	return buildMagicInvocationWithArgsCode(magicName, [
		`_args = ${JSON.stringify(args)}`,
	]);
}

function buildMagicInvocationWithArgsCode(magicName: string, argsLines: string[]): string {
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

function buildItoolInvocation(variableName: string, useManager: boolean): string {
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

function buildDataArrayInfoCode(variableName: string): string {
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

function buildDataArrayListCode(): string {
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

function buildDataArrayHtmlCode(variableName: string): string {
	return [
		'import IPython',
		'import json',
		'try:',
		'    import xarray as xr',
		`    ${ERLAB_TMP_PREFIX}ip = IPython.get_ipython()`,
		`    ${ERLAB_TMP_PREFIX}value = ${variableName}`,
		`    if isinstance(${ERLAB_TMP_PREFIX}value, xr.DataArray):`,
		'        with xr.set_options(display_expand_attrs=True):',
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
			shape?: number[];
			dtype?: string;
			ndim?: number;
			watched?: boolean;
			error?: string;
		} | null;
		if (!parsed || parsed.error || !parsed.dims || !parsed.sizes || !parsed.shape || !parsed.dtype || typeof parsed.ndim !== 'number') {
			dataArrayInfoCache.set(cacheKey, { value: undefined, timestamp: Date.now() });
			return;
		}

		const info: DataArrayInfo = {
			name: parsed.name ?? undefined,
			dims: parsed.dims,
			sizes: parsed.sizes,
			shape: parsed.shape,
			dtype: parsed.dtype,
			ndim: parsed.ndim,
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
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
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
					const decoded = decodeKernelOutputItem(item) ?? '';
					errors.push(normalizeKernelError(decoded));
				} else if (item.mime === stdoutMime || item.mime === textPlainMime) {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
				} else {
					const decoded = decodeKernelOutputItem(item);
					if (decoded) {
						chunks.push(decoded);
					}
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

function decodeKernelOutputItem(item: KernelOutputItem): string | undefined {
	if (item.data instanceof Uint8Array) {
		return textDecoder.decode(item.data);
	}
	if (item.data instanceof ArrayBuffer) {
		return textDecoder.decode(new Uint8Array(item.data));
	}
	if (ArrayBuffer.isView(item.data)) {
		const view = item.data;
		return textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (typeof item.data === 'string') {
		return item.data;
	}
	try {
		return JSON.stringify(item.data);
	} catch {
		return;
	}
}

function extractLastJsonLine(output: string): string | undefined {
	const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (line.startsWith('{') || line.startsWith('[') || line === 'null') {
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

function getActiveNotebookUri(): vscode.Uri | undefined {
	const notebookEditor = vscode.window.activeNotebookEditor;
	if (notebookEditor?.notebook) {
		return notebookEditor.notebook.uri;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor) {
		return getNotebookUriForDocument(activeEditor.document);
	}
	return;
}

function resolveNotebookUri(serialized?: string): vscode.Uri | undefined {
	if (serialized) {
		try {
			return vscode.Uri.parse(serialized);
		} catch {
			// Fall back to active notebook.
		}
	}
	return getActiveNotebookUri();
}

type DataArrayPanelCommandArgs = {
	variableName?: string;
	notebookUri?: string;
	watched?: boolean;
	ndim?: number;
	reveal?: boolean;
};

type DataArrayListEntry = DataArrayInfo & {
	variableName: string;
};

function normalizeDataArrayArgs(
	args?: DataArrayPanelCommandArgs
): DataArrayPanelCommandArgs | undefined {
	if (!args) {
		return;
	}
	if (args instanceof DataArrayTreeItem) {
		return {
			variableName: args.variableName,
			notebookUri: args.notebookUri.toString(),
			watched: args.info.watched,
			ndim: args.info.ndim,
		};
	}
	return args;
}

type DefinitionTarget = {
	document: vscode.TextDocument;
	range: vscode.Range;
};

async function findNotebookDefinitionLocation(
	notebook: vscode.NotebookDocument,
	variableName: string
): Promise<DefinitionTarget | undefined> {
	const escaped = escapeRegExp(variableName);
	const occurrence = findNotebookVariableOccurrence(notebook, escaped);
	if (occurrence) {
		const locations = await vscode.commands.executeCommand<vscode.Location[]>(
			'vscode.executeDefinitionProvider',
			occurrence.document.uri,
			occurrence.range.start
		);
		if (locations && locations.length > 0) {
			const location = locations[0];
			const targetDoc = await vscode.workspace.openTextDocument(location.uri);
			return { document: targetDoc, range: location.range };
		}
	}
	return findNotebookAssignmentLocation(notebook, escaped);
}

function findNotebookVariableOccurrence(
	notebook: vscode.NotebookDocument,
	escapedName: string
): DefinitionTarget | undefined {
	const occurrenceRegex = new RegExp(`\\b${escapedName}\\b`);
	for (const cell of notebook.getCells()) {
		if (cell.document.languageId !== 'python') {
			continue;
		}
		for (let lineIndex = 0; lineIndex < cell.document.lineCount; lineIndex += 1) {
			const line = cell.document.lineAt(lineIndex);
			const match = occurrenceRegex.exec(line.text);
			if (match?.index !== undefined) {
				const start = new vscode.Position(lineIndex, match.index);
				const end = new vscode.Position(lineIndex, match.index + match[0].length);
				return { document: cell.document, range: new vscode.Range(start, end) };
			}
		}
	}
	return;
}

function findNotebookAssignmentLocation(
	notebook: vscode.NotebookDocument,
	escapedName: string
): DefinitionTarget | undefined {
	const assignmentRegex = new RegExp(`^(\\s*)(${escapedName})\\s*(=|:|\\+=|-=|\\*=|/=|//=|%=|\\*\\*=|>>=|<<=|&=|\\^=|\\|=)`);
	for (const cell of notebook.getCells()) {
		if (cell.document.languageId !== 'python') {
			continue;
		}
		for (let lineIndex = 0; lineIndex < cell.document.lineCount; lineIndex += 1) {
			const line = cell.document.lineAt(lineIndex);
			const match = assignmentRegex.exec(line.text);
			if (match?.index !== undefined) {
				const leading = match[1]?.length ?? 0;
				const name = match[2] ?? '';
				const start = new vscode.Position(lineIndex, leading);
				const end = new vscode.Position(lineIndex, leading + name.length);
				return { document: cell.document, range: new vscode.Range(start, end) };
			}
		}
	}
	return;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class PinnedDataArrayStore {
	private readonly state: vscode.Memento;

	constructor(state: vscode.Memento) {
		this.state = state;
	}

	isPinned(notebookUri: vscode.Uri, variableName: string): boolean {
		return this.getPinned(notebookUri).includes(variableName);
	}

	getPinned(notebookUri: vscode.Uri): string[] {
		const allPinned = this.state.get<Record<string, string[]>>(PINNED_DATAARRAYS_KEY, {});
		return allPinned[notebookUri.toString()] ?? [];
	}

	async pin(notebookUri: vscode.Uri, variableName: string): Promise<void> {
		const pinned = this.getPinned(notebookUri);
		if (pinned.includes(variableName)) {
			return;
		}
		await this.setPinned(notebookUri, [...pinned, variableName]);
	}

	async unpin(notebookUri: vscode.Uri, variableName: string): Promise<void> {
		const pinned = this.getPinned(notebookUri).filter((name) => name !== variableName);
		await this.setPinned(notebookUri, pinned);
	}

	async setPinned(notebookUri: vscode.Uri, pinned: string[]): Promise<void> {
		const allPinned = this.state.get<Record<string, string[]>>(PINNED_DATAARRAYS_KEY, {});
		const next = { ...allPinned, [notebookUri.toString()]: pinned };
		await this.state.update(PINNED_DATAARRAYS_KEY, next);
	}
}

class DataArrayPanelProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly pinnedStore: PinnedDataArrayStore;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
	private treeView?: vscode.TreeView<vscode.TreeItem>;
	private itemsByName = new Map<string, DataArrayTreeItem>();
	private lastItems: vscode.TreeItem[] = [];
	private refreshPending = false;
	private refreshTimer: NodeJS.Timeout | undefined;
	private executionInProgress = false;

	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(pinnedStore: PinnedDataArrayStore) {
		this.pinnedStore = pinnedStore;
	}

	setTreeView(view: vscode.TreeView<vscode.TreeItem>): void {
		this.treeView = view;
	}

	requestRefresh(): void {
		if (this.executionInProgress) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			return;
		}
		if (!this.treeView || !this.treeView.visible) {
			this.refreshPending = true;
			if (this.refreshTimer) {
				clearTimeout(this.refreshTimer);
				this.refreshTimer = undefined;
			}
			return;
		}
		this.refreshPending = false;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.onDidChangeTreeDataEmitter.fire(undefined);
		}, 250);
	}

	setExecutionInProgress(active: boolean): void {
		this.executionInProgress = active;
		if (!active && this.refreshPending) {
			this.requestRefresh();
		}
	}

	async reveal(variableName: string): Promise<void> {
		const item = this.itemsByName.get(variableName);
		if (!item || !this.treeView) {
			return;
		}
		try {
			await this.treeView.reveal(item, { focus: true, select: true, expand: false });
		} catch {
			// Ignore reveal failures for stale items.
		}
	}

	getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(): Promise<vscode.TreeItem[]> {
		if (this.executionInProgress) {
			return this.lastItems.length > 0
				? this.lastItems
				: [new DataArrayMessageItem('Refreshing after cell execution…')];
		}

		const notebookUri = getActiveNotebookUri();
		if (!notebookUri) {
			this.itemsByName.clear();
			this.lastItems = [new DataArrayMessageItem('Open a notebook to see DataArrays.')];
			return this.lastItems;
		}
		const { entries, error } = await listDataArrays(notebookUri);
		if (error) {
			this.itemsByName.clear();
			this.lastItems = [new DataArrayMessageItem(error)];
			return this.lastItems;
		}
		if (entries.length === 0) {
			this.itemsByName.clear();
			this.lastItems = [new DataArrayMessageItem('No DataArrays found in the active notebook.')];
			return this.lastItems;
		}
		const pinned = this.pinnedStore.getPinned(notebookUri);
		const entryMap = new Map(entries.map((entry) => [entry.variableName, entry]));
		const prunedPinned = pinned.filter((name) => entryMap.has(name));
		if (prunedPinned.length !== pinned.length) {
			await this.pinnedStore.setPinned(notebookUri, prunedPinned);
		}
		const pinnedEntries = prunedPinned.map((name) => entryMap.get(name)).filter(Boolean) as DataArrayListEntry[];
		const unpinnedEntries = entries
			.filter((entry) => !prunedPinned.includes(entry.variableName))
			.sort((a, b) => a.variableName.localeCompare(b.variableName));
		const ordered = [...pinnedEntries, ...unpinnedEntries];
		this.itemsByName = new Map(
			ordered.map((entry) => [entry.variableName, new DataArrayTreeItem(entry, notebookUri, prunedPinned.includes(entry.variableName))])
		);
		this.lastItems = Array.from(this.itemsByName.values());
		return this.lastItems;
	}
}

class DataArrayTreeItem extends vscode.TreeItem {
	readonly variableName: string;
	readonly info: DataArrayListEntry;
	readonly notebookUri: vscode.Uri;
	readonly pinned: boolean;

	constructor(info: DataArrayListEntry, notebookUri: vscode.Uri, pinned: boolean) {
		super(info.variableName, vscode.TreeItemCollapsibleState.None);
		this.variableName = info.variableName;
		this.info = info;
		this.notebookUri = notebookUri;
		this.pinned = pinned;

		const dimsLabel = formatDimsWithSizes(info.dims, info.sizes);
		const namePrefix = info.name ? `'${info.name}' ` : '';
		const descriptionLabel = dimsLabel ? `${namePrefix}(${dimsLabel})` : namePrefix.trim();
		this.description = descriptionLabel;
		const statusIcons = [
			pinned ? '$(pin) pinned' : '',
			info.watched ? '$(eye) watched' : '',
		].filter(Boolean);
		const statusLine = statusIcons.length > 0 ? `- status: ${statusIcons.join(' ')}\n` : '';
		const tooltip = new vscode.MarkdownString(
			`**${info.variableName}**\n\n` +
			`${statusLine}` +
			`- name: ${info.name ?? '—'}\n` +
			`- dims: ${dimsLabel || 'none'}\n` +
			`- shape: ${info.shape.length ? info.shape.join('x') : 'scalar'}\n` +
			`- dtype: ${info.dtype}\n` +
			`- ndim: ${info.ndim}`
		);
		tooltip.supportThemeIcons = true;
		this.tooltip = tooltip;
		this.iconPath = undefined;
		this.command = {
			command: 'erlab.dataArray.openDetail',
			title: 'Open DataArray Details',
			arguments: [{
				variableName: info.variableName,
				notebookUri: notebookUri.toString(),
				ndim: info.ndim,
			}],
		};
		if (pinned && info.watched) {
			this.contextValue = 'dataArrayItemPinnedWatched';
		} else if (pinned) {
			this.contextValue = 'dataArrayItemPinned';
		} else if (info.watched) {
			this.contextValue = 'dataArrayItemWatched';
		} else {
			this.contextValue = 'dataArrayItem';
		}
	}
}

class DataArrayMessageItem extends vscode.TreeItem {
	constructor(message: string) {
		super(message, vscode.TreeItemCollapsibleState.None);
		this.contextValue = 'dataArrayMessage';
	}
}

class DataArrayDetailViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private executionInProgress = false;
	private pendingDetail: { notebookUri: vscode.Uri; variableName: string } | undefined;
	private hasContent = false;
	private lastHtml: string | undefined;

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: false };
		if (!this.hasContent) {
			view.webview.html = buildDataArrayHtml(buildDataArrayMessage('Select a DataArray to see details.'));
		} else if (this.lastHtml) {
			view.webview.html = this.lastHtml;
		}
		if (this.pendingDetail) {
			const pending = this.pendingDetail;
			this.pendingDetail = undefined;
			void this.showDetail(pending.notebookUri, pending.variableName);
		}
	}

	setExecutionInProgress(active: boolean): void {
		this.executionInProgress = active;
		if (!active && this.pendingDetail) {
			const pending = this.pendingDetail;
			this.pendingDetail = undefined;
			void this.showDetail(pending.notebookUri, pending.variableName);
		}
	}

	async showDetail(notebookUri: vscode.Uri, variableName: string): Promise<void> {
		if (!this.view) {
			this.pendingDetail = { notebookUri, variableName };
			return;
		}
		if (!this.view.visible) {
			this.view.show(true);
		}
		this.view.title = `DataArray: ${variableName}`;
		if (this.executionInProgress) {
			this.pendingDetail = { notebookUri, variableName };
			if (!this.hasContent) {
				this.view.webview.html = buildDataArrayHtml(
					buildDataArrayMessage('Waiting for cell execution to finish…')
				);
				this.hasContent = true;
			}
			return;
		}
		try {
			const output = await executeInKernelForOutput(notebookUri, buildDataArrayHtmlCode(variableName));
			const line = extractLastJsonLine(output);
			if (!line) {
				this.lastHtml = buildDataArrayHtml(buildDataArrayMessage('No HTML representation returned.'));
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			const parsed = JSON.parse(line) as { html?: string | null; error?: string };
			if (parsed?.error) {
				this.lastHtml = buildDataArrayHtml(buildDataArrayMessage(parsed.error));
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			if (!parsed?.html) {
				this.lastHtml = buildDataArrayHtml(buildDataArrayMessage('No HTML representation available.'));
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			this.lastHtml = buildDataArrayHtml(parsed.html);
			this.view.webview.html = this.lastHtml;
			this.hasContent = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastHtml = buildDataArrayHtml(buildDataArrayMessage(message));
			this.view.webview.html = this.lastHtml;
			this.hasContent = true;
		}
	}
}

async function listDataArrays(
	notebookUri: vscode.Uri
): Promise<{ entries: DataArrayListEntry[]; error?: string }> {
	try {
		const output = await executeInKernelForOutput(notebookUri, buildDataArrayListCode());
		const line = extractLastJsonLine(output);
		if (!line) {
			return { entries: [], error: 'No response from the kernel. Run a cell and refresh.' };
		}
		const parsed = JSON.parse(line) as Array<{
			variableName?: string;
			name?: string | null;
			dims?: string[];
			sizes?: Record<string, number>;
			shape?: number[];
			dtype?: string;
			ndim?: number;
			watched?: boolean;
			error?: string;
		}> | { error?: string };
		if (!Array.isArray(parsed)) {
			return { entries: [], error: parsed?.error ?? 'Kernel returned unexpected data.' };
		}
		const entries = parsed
			.filter((entry) => entry && entry.variableName && entry.dims && entry.sizes && entry.shape && entry.dtype && typeof entry.ndim === 'number')
			.filter((entry) => isValidPythonIdentifier(entry.variableName as string))
			.map((entry) => ({
				variableName: entry.variableName as string,
				name: entry.name ?? undefined,
				dims: entry.dims as string[],
				sizes: entry.sizes as Record<string, number>,
				shape: entry.shape as number[],
				dtype: entry.dtype as string,
				ndim: entry.ndim as number,
				watched: entry.watched ?? false,
			}));
		return { entries };
	} catch {
		return { entries: [], error: 'Failed to query the kernel. Ensure the Jupyter kernel is running.' };
	}
}

function buildDataArrayHtml(content: string): string {
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'  <meta charset="utf-8">',
		'  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
		'  <title>DataArray</title>',
		'</head>',
		'<body>',
		content,
		'</body>',
		'</html>',
	].join('\n');
}

function buildDataArrayMessage(message: string): string {
	const escaped = message
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<pre>${escaped}</pre>`;
}

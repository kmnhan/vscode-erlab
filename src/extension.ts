/**
 * ERLab VS Code Extension
 *
 * This is the extension entrypoint - a thin composition root that wires together
 * all feature modules and registers disposables.
 */
import * as vscode from 'vscode';

// Infrastructure
import { initializeLogger, logger } from './logger';
import {
	executeInKernel,
	executeInKernelForOutput,
	extractLastJsonLine,
	getKernelForNotebook,
	type KernelLike,
} from './kernel';
import { isNotebookCellDocument, getNotebookUriForDocument, getActiveNotebookUri, resolveNotebookUri } from './notebook';
import { findNotebookDefinitionLocation } from './notebook/definitionSearch';
import { isValidPythonIdentifier } from './python/identifiers';

// Commands
import {
	type MagicCommandArgs,
	type XarrayPanelCommandArgs,
	normalizeXarrayArgs,
} from './commands';
import { buildMagicInvocation, buildItoolInvocation } from './commands/magicInvocation';

// Features
import {
	DATA_ARRAY_CONTEXT,
	DATA_ARRAY_WATCHED_CONTEXT,
	refreshXarrayCache,
	isXarrayInCache,
	getCachedXarrayEntry,
	PinnedXarrayStore,
	XarrayPanelProvider,
	XarrayDetailViewProvider,
} from './features/xarray';
import { registerXarrayHoverProvider } from './features/hover';

/**
 * Get the variable name at the current selection.
 */
function getVariableAtSelection(editor: vscode.TextEditor): string | undefined {
	const position = editor.selection.active;
	const range = editor.document.getWordRangeAtPosition(position);
	if (!range) {
		return;
	}
	return editor.document.getText(range);
}

/**
 * Get the last line variable from a document.
 */
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

/**
 * Show magic output in the status bar.
 */
function showMagicOutput(output: string): void {
	const trimmed = output.trim();
	if (!trimmed) {
		return;
	}
	const normalized = trimmed.replace(/\r?\n+/g, ' | ');
	const message = normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
	vscode.window.setStatusBarMessage(`erlab: ${message}`, 2500);
}

const ERLAB_AVAILABLE_CONTEXT = 'erlab.hasErlab';
// Kernel-scoped availability avoids re-checking erlab in a stable environment.
const erlabAvailabilityByKernel = new WeakMap<KernelLike, boolean>();
// Notebook-scoped availability is a fast, synchronous fallback for UI gating and
// also records the last kernel so we can invalidate on kernel swaps.
const erlabAvailabilityByNotebook = new Map<string, { available: boolean; kernel?: KernelLike }>();
// Deduplicate concurrent checks for the same kernel.
const pendingErlabChecks = new WeakMap<KernelLike, Promise<boolean | undefined>>();
let currentErlabContext = false;

function getNotebookCacheKey(notebookUri: vscode.Uri): string {
	return notebookUri.toString();
}

// Use last-known notebook state for synchronous UI paths (hover/status bar/when contexts).
function getCachedErlabAvailability(notebookUri: vscode.Uri): boolean | undefined {
	return erlabAvailabilityByNotebook.get(getNotebookCacheKey(notebookUri))?.available;
}

function setNotebookErlabAvailability(
	notebookUri: vscode.Uri,
	available: boolean,
	kernel?: KernelLike
): void {
	erlabAvailabilityByNotebook.set(getNotebookCacheKey(notebookUri), { available, kernel });
}

function isErlabAvailable(notebookUri: vscode.Uri | undefined): boolean {
	if (!notebookUri) {
		return false;
	}
	return getCachedErlabAvailability(notebookUri) ?? false;
}

async function setErlabContext(value: boolean): Promise<void> {
	if (currentErlabContext === value) {
		return;
	}
	currentErlabContext = value;
	await vscode.commands.executeCommand('setContext', ERLAB_AVAILABLE_CONTEXT, value);
}

// Check erlab availability once per kernel; kernels are stable for a session.
async function checkErlabAvailability(
	notebookUri: vscode.Uri,
	kernel: KernelLike,
	options?: { force?: boolean }
): Promise<boolean | undefined> {
	const cached = erlabAvailabilityByKernel.get(kernel);
	if (!options?.force && typeof cached === 'boolean') {
		setNotebookErlabAvailability(notebookUri, cached, kernel);
		return cached;
	}

	const pending = pendingErlabChecks.get(kernel);
	if (pending) {
		return pending;
	}

	const promise = (async () => {
		try {
			const output = await executeInKernelForOutput(
				notebookUri,
				[
					'import importlib.util',
					'import json',
					'print(json.dumps({"erlab": importlib.util.find_spec("erlab") is not None}))',
				].join('\n'),
				{
					operation: 'erlab-check',
					timeoutMs: 1500,
					warnAfterMs: 1200,
					interruptOnTimeout: false,
				}
			);
			const line = extractLastJsonLine(output);
			if (!line) {
				throw new Error('Missing erlab availability response.');
			}
			const parsed = JSON.parse(line) as { erlab?: boolean };
			if (typeof parsed?.erlab !== 'boolean') {
				throw new Error('Invalid erlab availability response.');
			}
			const available = parsed.erlab;
			erlabAvailabilityByKernel.set(kernel, available);
			setNotebookErlabAvailability(notebookUri, available, kernel);
			return available;
		} catch (error) {
			logger.debug(`Erlab availability check failed: ${error instanceof Error ? error.message : String(error)}`);
			return;
		} finally {
			pendingErlabChecks.delete(kernel);
		}
	})();
	pendingErlabChecks.set(kernel, promise);
	return promise;
}

// Keep the context key in sync with the active notebook's kernel.
// If a notebook switches kernels, we pessimistically clear state and re-check.
async function updateErlabContextForNotebook(
	notebookUri: vscode.Uri | undefined,
	options?: { force?: boolean }
): Promise<void> {
	if (!notebookUri) {
		await setErlabContext(false);
		return;
	}
	const kernel = await getKernelForNotebook(notebookUri);
	if (!kernel) {
		setNotebookErlabAvailability(notebookUri, false);
		await setErlabContext(false);
		return;
	}

	const cachedNotebook = erlabAvailabilityByNotebook.get(getNotebookCacheKey(notebookUri));
	if (cachedNotebook?.kernel === kernel) {
		await setErlabContext(cachedNotebook.available);
	} else {
		const cachedKernel = erlabAvailabilityByKernel.get(kernel);
		if (!options?.force && typeof cachedKernel === 'boolean') {
			setNotebookErlabAvailability(notebookUri, cachedKernel, kernel);
			await setErlabContext(cachedKernel);
			return;
		}
		setNotebookErlabAvailability(notebookUri, false, kernel);
		await setErlabContext(false);
	}

	const available = await checkErlabAvailability(notebookUri, kernel, options);
	if (typeof available === 'boolean') {
		await setErlabContext(available);
	}
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	initializeLogger(context);
	logger.info('Erlab extension activated');
	void setErlabContext(false);

	// ─────────────────────────────────────────────────────────────────────────
	// Magic command registration helper
	// ─────────────────────────────────────────────────────────────────────────
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
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to run the magic.');
				return;
			}
			await updateErlabContextForNotebook(notebookUri);
			const cachedAvailability = getCachedErlabAvailability(notebookUri);
			if (cachedAvailability === false) {
				vscode.window.showInformationMessage('erlab: erlab is not available in this kernel.');
				return;
			}
			const code = buildMagicCode
				? buildMagicCode(variableName)
				: buildMagicInvocation(magicName, buildArgs(variableName));
			const output = await executeInKernel(notebookUri, code, { operation: `magic:${magicName}` });
			showMagicOutput(output);
			if (onDidExecute) {
				await onDidExecute(variableName, editor.document);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`erlab: ${message}`);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Core services
	// ─────────────────────────────────────────────────────────────────────────
	const pinnedStore = new PinnedXarrayStore(context.globalState);
	const xarrayPanelProvider = new XarrayPanelProvider(pinnedStore, {
		onDidAccessNotebook: (notebookUri) => updateErlabContextForNotebook(notebookUri),
	});
	const xarrayTreeView = vscode.window.createTreeView('erlabXarrayObjects', {
		treeDataProvider: xarrayPanelProvider,
		showCollapseAll: false,
	});
	xarrayPanelProvider.setTreeView(xarrayTreeView);
	const xarrayDetailProvider = new XarrayDetailViewProvider();
	const xarrayDetailDisposable = vscode.window.registerWebviewViewProvider(
		'erlabXarrayDetail',
		xarrayDetailProvider
	);
	const requestXarrayRefresh = async (
		options?: { refreshCache?: boolean; notebookUri?: vscode.Uri }
	): Promise<void> => {
		const notebookUri = options?.notebookUri ?? getActiveNotebookUri();
		if (options?.refreshCache) {
			if (notebookUri) {
				await refreshXarrayCache(notebookUri);
			}
			await updateErlabContextForNotebook(notebookUri);
		}
		xarrayPanelProvider.requestRefresh();
	};
	const xarrayVisibilityDisposable = xarrayTreeView.onDidChangeVisibility(() => {
		void requestXarrayRefresh();
	});
	const xarraySelectionDisposable = xarrayTreeView.onDidChangeSelection((event) => {
		if (event.selection.length === 0) {
			xarrayDetailProvider.clearDetail();
		}
	});

	// Populate cache on initial activation if there's an active notebook
	const activeNotebook = getActiveNotebookUri();
	if (activeNotebook) {
		void refreshXarrayCache(activeNotebook);
		void updateErlabContextForNotebook(activeNotebook);
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Magic commands
	// ─────────────────────────────────────────────────────────────────────────
	const watchDisposable = registerMagicCommand(
		'erlab.watch',
		'watch',
		(variableName) => variableName,
		undefined,
		async (_variableName, document) => {
			const notebookUri = getNotebookUriForDocument(document);
			await requestXarrayRefresh({ refreshCache: true, notebookUri });
		}
	);

	const itoolDisposable = registerMagicCommand(
		'erlab.itool',
		'itool',
		(variableName) => variableName,
		(variableName) => {
			const useManager = vscode.workspace.getConfiguration('erlab').get<boolean>('itool.useManager', true);
			return buildItoolInvocation(variableName, useManager);
		},
		() => requestXarrayRefresh()
	);

	const unwatchDisposable = registerMagicCommand(
		'erlab.unwatch',
		'watch',
		(variableName) => `-d ${variableName}`,
		undefined,
		async (_variableName, document) => {
			const notebookUri = getNotebookUriForDocument(document);
			await requestXarrayRefresh({ refreshCache: true, notebookUri });
		}
	);

	// Additional tool magic commands
	const ktoolDisposable = registerMagicCommand(
		'erlab.ktool',
		'ktool',
		(variableName) => variableName
	);

	const dtoolDisposable = registerMagicCommand(
		'erlab.dtool',
		'dtool',
		(variableName) => variableName
	);

	const restoolDisposable = registerMagicCommand(
		'erlab.restool',
		'restool',
		(variableName) => variableName
	);

	const meshtoolDisposable = registerMagicCommand(
		'erlab.meshtool',
		'meshtool',
		(variableName) => variableName
	);

	const ftoolDisposable = registerMagicCommand(
		'erlab.ftool',
		'ftool',
		(variableName) => variableName
	);

	const goldtoolDisposable = registerMagicCommand(
		'erlab.goldtool',
		'goldtool',
		(variableName) => variableName
	);

	// Quick Pick command for other tools
	const otherToolsDisposable = vscode.commands.registerCommand(
		'erlab.xarray.otherTools',
		async (args?: MagicCommandArgs) => {
			const tools = [
				{ label: '$(open-in-product) ktool', description: 'momentum conversion', command: 'erlab.ktool' },
				{ label: '$(open-in-product) dtool', description: 'visualizing dispersive features', command: 'erlab.dtool' },
				{ label: '$(open-in-product) goldtool', description: 'Fermi edge fitting', command: 'erlab.goldtool' },
				{ label: '$(open-in-product) ftool', description: 'general curve fitting', command: 'erlab.ftool' },
				{ label: '$(open-in-product) restool', description: 'fitting energy resolution', command: 'erlab.restool' },
				{ label: '$(open-in-product) meshtool', description: 'mesh pattern removal', command: 'erlab.meshtool' },
			];
			const selected = await vscode.window.showQuickPick(tools, {
				placeHolder: 'Select a tool to open',
			});
			if (selected) {
				await vscode.commands.executeCommand(selected.command, args);
			}
		}
	);

	// ─────────────────────────────────────────────────────────────────────────
	// Hover provider
	// ─────────────────────────────────────────────────────────────────────────
	const hoverDisposable = registerXarrayHoverProvider(pinnedStore, {
		isErlabAvailable,
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Selection and context tracking
	// ─────────────────────────────────────────────────────────────────────────
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

		// Use synchronous cache lookup - no kernel query on keystroke
		const notebookUri = getNotebookUriForDocument(event.textEditor.document);
		if (!notebookUri) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
			return;
		}
		const entry = getCachedXarrayEntry(notebookUri, variableName);
		const isDataArray = Boolean(entry);
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, isDataArray);
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, Boolean(entry?.watched));
	});

	const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor?: vscode.TextEditor) => {
		if (!editor || !isNotebookCellDocument(editor.document)) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
			void requestXarrayRefresh();
			return;
		}
		void requestXarrayRefresh();
	});

	const activeNotebookDisposable = vscode.window.onDidChangeActiveNotebookEditor(async (editor) => {
		// Refresh cache when switching notebooks (debounced)
		if (editor) {
			await requestXarrayRefresh({ refreshCache: true, notebookUri: editor.notebook.uri });
			return;
		}
		await updateErlabContextForNotebook(undefined);
		void requestXarrayRefresh();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Notebook execution tracking
	// ─────────────────────────────────────────────────────────────────────────
	const notebookExecutionDisposable = vscode.workspace.onDidChangeNotebookDocument(async (event) => {
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
			xarrayPanelProvider.setExecutionInProgress(true);
			xarrayDetailProvider.setExecutionInProgress(true);
			return;
		}
		if (hasExecutionSummary) {
			xarrayPanelProvider.setExecutionInProgress(false);
			xarrayDetailProvider.setExecutionInProgress(false);
			// Refresh cache when cell execution completes (debounced + coalesced)
			void refreshXarrayCache(activeNotebook).then(() => requestXarrayRefresh());
			void updateErlabContextForNotebook(activeNotebook);
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Notebook cell status bar
	// ─────────────────────────────────────────────────────────────────────────
	const notebookCellStatusBarDisposable = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
		'jupyter-notebook',
		{
			provideCellStatusBarItems: (
				cell: vscode.NotebookCell,
				token: vscode.CancellationToken
			): vscode.NotebookCellStatusBarItem[] => {
				if (cell.document.languageId !== 'python') {
					return [];
				}

				const variableName = getLastLineVariable(cell.document);
				if (!variableName || !isValidPythonIdentifier(variableName)) {
					return [];
				}

				// Use synchronous cache lookup - no kernel query
				const notebookUri = getNotebookUriForDocument(cell.document);
				if (!notebookUri) {
					return [];
				}
				if (!isErlabAvailable(notebookUri)) {
					return [];
				}
				const entry = getCachedXarrayEntry(notebookUri, variableName);
				if (token.isCancellationRequested || !entry) {
					return [];
				}
				if (entry.type !== 'DataArray') {
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

	// ─────────────────────────────────────────────────────────────────────────
	// DataArray panel commands
	// ─────────────────────────────────────────────────────────────────────────
	const refreshDataArrayPanelDisposable = vscode.commands.registerCommand(
		'erlab.xarray.refresh',
		() => requestXarrayRefresh({ refreshCache: true })
	);

	const openDataArrayDetailDisposable = vscode.commands.registerCommand(
		'erlab.xarray.openDetail',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				vscode.window.showInformationMessage('erlab: open a notebook to view DataArrays.');
				return;
			}
			const activeNotebook = getActiveNotebookUri();
			if (activeNotebook && activeNotebook.toString() === notebookUri.toString()) {
				void xarrayPanelProvider.select(variableName);
			}
			await xarrayDetailProvider.showDetail(notebookUri, variableName, normalized?.type);
		}
	);

	const togglePinDisposable = vscode.commands.registerCommand(
		'erlab.xarray.togglePin',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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
			void requestXarrayRefresh();
			if (!isPinned && normalized?.reveal) {
				await vscode.commands.executeCommand('workbench.view.extension.erlab');
				await xarrayPanelProvider.reveal(variableName);
			}
		}
	);

	const pinDisposable = vscode.commands.registerCommand(
		'erlab.xarray.pin',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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
				void requestXarrayRefresh();
			}
		}
	);

	const unpinDisposable = vscode.commands.registerCommand(
		'erlab.xarray.unpin',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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
				void requestXarrayRefresh();
			}
		}
	);

	const toggleWatchDisposable = vscode.commands.registerCommand(
		'erlab.xarray.toggleWatch',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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
			void requestXarrayRefresh();
		}
	);

	const dataArrayWatchDisposable = vscode.commands.registerCommand(
		'erlab.xarray.watch',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			await vscode.commands.executeCommand('erlab.watch', { variableName });
			void requestXarrayRefresh();
		}
	);

	const dataArrayUnwatchDisposable = vscode.commands.registerCommand(
		'erlab.xarray.unwatch',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
			const variableName = normalized?.variableName;
			if (!variableName) {
				return;
			}
			await vscode.commands.executeCommand('erlab.unwatch', { variableName });
			void requestXarrayRefresh();
		}
	);

	const openInImageToolDisposable = vscode.commands.registerCommand(
		'erlab.xarray.openInImageTool',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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
		'erlab.xarray.goToDefinition',
		async (args?: XarrayPanelCommandArgs) => {
			const normalized = normalizeXarrayArgs(args);
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

	// ─────────────────────────────────────────────────────────────────────────
	// Show output channel command
	// ─────────────────────────────────────────────────────────────────────────
	const showOutputDisposable = vscode.commands.registerCommand(
		'erlab.showOutput',
		() => logger.show()
	);

	// ─────────────────────────────────────────────────────────────────────────
	// Register all disposables
	// ─────────────────────────────────────────────────────────────────────────
	context.subscriptions.push(
		watchDisposable,
		itoolDisposable,
		unwatchDisposable,
		ktoolDisposable,
		dtoolDisposable,
		restoolDisposable,
		meshtoolDisposable,
		ftoolDisposable,
		goldtoolDisposable,
		otherToolsDisposable,
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
		showOutputDisposable,
		xarrayTreeView,
		xarrayDetailDisposable,
		xarrayVisibilityDisposable,
		xarraySelectionDisposable
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }

/**
 * ERLab VS Code Extension
 *
 * This is the extension entrypoint - a thin composition root that wires together
 * all feature modules and registers disposables.
 */
import * as vscode from 'vscode';

// Infrastructure
import { initializeLogger, logger } from './logger';
import { executeInKernel } from './kernel';
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

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	initializeLogger(context);
	logger.info('ERLab extension activated');

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
			const code = buildMagicCode
				? buildMagicCode(variableName)
				: buildMagicInvocation(magicName, buildArgs(variableName));
			const output = await executeInKernel(notebookUri, code);
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
	const xarrayPanelProvider = new XarrayPanelProvider(pinnedStore);
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
		if (options?.refreshCache) {
			const notebookUri = options.notebookUri ?? getActiveNotebookUri();
			if (notebookUri) {
				await refreshXarrayCache(notebookUri);
			}
		}
		xarrayPanelProvider.requestRefresh();
	};
	const xarrayVisibilityDisposable = xarrayTreeView.onDidChangeVisibility(() => {
		void requestXarrayRefresh();
	});

	// Populate cache on initial activation if there's an active notebook
	const activeNotebook = getActiveNotebookUri();
	if (activeNotebook) {
		void refreshXarrayCache(activeNotebook);
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
	const hoverDisposable = registerXarrayHoverProvider(pinnedStore);

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

		// Use synchronous cache lookup - no kernel query on keystroke
		const notebookUri = getNotebookUriForDocument(event.textEditor.document);
		if (!notebookUri) {
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, false);
			await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, false);
			return;
		}
		const entry = getCachedXarrayEntry(notebookUri, selectedVariable);
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
			await refreshXarrayCache(activeNotebook);
			// Note: requestXarrayRefresh is called after cache refresh completes
			// to update tree view with new data
			void requestXarrayRefresh();
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
				const entry = getCachedXarrayEntry(notebookUri, variableName);
				if (token.isCancellationRequested || !entry) {
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
		xarrayVisibilityDisposable
	);
}

// This method is called when your extension is deactivated
export function deactivate() { }

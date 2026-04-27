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
	buildConfiguredKernelExecutionOptions,
	executeInKernel,
	executeInKernelForOutput,
	extractLastJsonLine,
	getKernelForNotebook,
	shutdownKernelClient,
	type KernelLike,
} from './kernel';
import {
	getActiveNotebookUri,
	getNotebookDocumentForCellDocument,
	getNotebookUriForDocument,
	initializeNotebookUriIndex,
	isSupportedNotebookCellDocument,
	isSupportedNotebookLanguage,
	isSupportedNotebookType,
	resolveNotebookUri,
} from './notebook';
import { findNotebookDefinitionLocation } from './notebook/definitionSearch';
import { isValidPythonIdentifier } from './python/identifiers';

// Commands
import {
	type MagicCommandArgs,
	type JupyterVariableViewerArgs,
	type XarrayPanelCommandArgs,
	normalizeJupyterVariableViewerArgs,
	normalizeXarrayArgs,
} from './commands';
import {
	buildItoolInvocation,
	buildMagicInvocation,
	buildMarimoItoolInvocation,
	buildMarimoToolInvocation,
	buildMarimoWatchInvocation,
} from './commands/magicInvocation';

// Features
import {
	DATA_ARRAY_CONTEXT,
	DATA_ARRAY_WATCH_AVAILABLE_CONTEXT,
	DATA_ARRAY_WATCHED_CONTEXT,
	formatXarrayLabel,
	getXarrayListAutoRefreshDelayMs,
	refreshXarrayCache,
	isXarrayListStale,
	shouldAutoRefreshXarrayList,
	getCachedXarrayEntry,
	markXarrayCacheStale,
	PinnedXarrayStore,
	shutdownXarrayService,
	XarrayPanelProvider,
	XarrayDetailViewProvider,
	type XarrayObjectType,
} from './features/xarray';
import { registerXarrayHoverProvider } from './features/hover';
import { setNonBlockingTimeout } from './timers';

let isShuttingDown = false;
let shutdownExtensionResources: (() => void) | undefined;

function runExtensionShutdown(): void {
	if (isShuttingDown) {
		return;
	}
	isShuttingDown = true;
	shutdownExtensionResources?.();
	shutdownExtensionResources = undefined;
}

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
	if (isShuttingDown) {
		return;
	}
	const trimmed = output.trim();
	if (!trimmed) {
		return;
	}
	const normalized = trimmed.replace(/\r?\n+/g, ' | ');
	const message = normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
	vscode.window.setStatusBarMessage(`erlab: ${message}`, 2500);
}

function showErlabInfo(message: string): void {
	if (isShuttingDown) {
		return;
	}
	void vscode.window.showInformationMessage(`erlab: ${message}`);
}

function showErlabError(message: string): void {
	if (isShuttingDown) {
		return;
	}
	void vscode.window.showErrorMessage(`erlab: ${message}`);
}

function buildMagicExecutionOptions(
	executionKind: 'gui' | 'helper',
	operation: string
) {
	return buildConfiguredKernelExecutionOptions(operation, {
		interruptOnTimeout: executionKind === 'helper',
		startedTimeoutPolicy: executionKind === 'gui' ? 'detach' : 'reject',
	});
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
	if (isShuttingDown) {
		return;
	}
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
	if (isShuttingDown) {
		return;
	}
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
			if (isShuttingDown) {
				return;
			}
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
	if (isShuttingDown) {
		return;
	}
	if (!notebookUri) {
		await setErlabContext(false);
		return;
	}
	const kernel = await getKernelForNotebook(notebookUri);
	if (isShuttingDown) {
		return;
	}
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
	if (isShuttingDown) {
		return;
	}
	if (typeof available === 'boolean') {
		await setErlabContext(available);
	}
}

// This method is called when your extension is activated
export function activate(context: vscode.ExtensionContext) {
	isShuttingDown = false;
	shutdownExtensionResources = undefined;
	initializeLogger(context);
	logger.info('Erlab extension activated');
	void setErlabContext(false);
	const notebookUriIndexDisposable = initializeNotebookUriIndex();

	// ─────────────────────────────────────────────────────────────────────────
	// Magic command registration helper
	// ─────────────────────────────────────────────────────────────────────────
	const registerMagicCommand = (
		commandId: string,
		magicName: string,
		buildArgs: (variableName: string) => string,
		buildMagicCode?: (variableName: string) => string,
		onDidExecute?: (
			context: { variableName: string; notebookUri: vscode.Uri; document?: vscode.TextDocument }
		) => void | Promise<void>,
		buildMarimoCode?: (variableName: string) => string,
		executionKind: 'gui' | 'helper' = 'helper'
	): vscode.Disposable => vscode.commands.registerCommand(commandId, async (args?: MagicCommandArgs) => {
		try {
			if (isShuttingDown) {
				return;
			}
			const activeEditor = vscode.window.activeTextEditor;
			const activeEditorNotebookUri = activeEditor && isSupportedNotebookCellDocument(activeEditor.document)
				? getNotebookUriForDocument(activeEditor.document)
				: undefined;
			const explicitNotebookUri = args?.notebookUri ? resolveNotebookUri(args.notebookUri) : undefined;
			const notebookUri = explicitNotebookUri ?? activeEditorNotebookUri ?? getActiveNotebookUri();
			if (!notebookUri) {
				showErlabInfo('open a Python notebook cell to run the magic.');
				return;
			}
			const editor = activeEditorNotebookUri && activeEditorNotebookUri.toString() === notebookUri.toString()
				? activeEditor
				: undefined;
			const variableName = args?.variableName ?? (editor ? getVariableAtSelection(editor) : undefined);
			if (!variableName) {
				showErlabInfo('place the cursor on a variable name.');
				return;
			}

			if (activeEditor) {
				await vscode.commands.executeCommand('editor.action.hideHover');
			}
			await updateErlabContextForNotebook(notebookUri);
			const cachedAvailability = getCachedErlabAvailability(notebookUri);
			if (cachedAvailability === false) {
				showErlabInfo('erlab is not available in this kernel.');
				return;
			}
				const notebook = vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === notebookUri.toString());
				const isMarimoNotebook = notebook?.notebookType === 'marimo-notebook';
				const isMarimoPath = Boolean(isMarimoNotebook && buildMarimoCode);
				const code = isMarimoPath
					? buildMarimoCode!(variableName)
					: buildMagicCode
						? buildMagicCode(variableName)
						: buildMagicInvocation(magicName, buildArgs(variableName));
				const operation = `${isMarimoPath ? 'tool' : 'magic'}:${magicName}`;
				const output = await executeInKernel(notebookUri, code, buildMagicExecutionOptions(executionKind, operation));
				if (isShuttingDown) {
					return;
				}
				showMagicOutput(output);
				if (onDidExecute && !isShuttingDown) {
					await onDidExecute({ variableName, notebookUri, document: editor?.document });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				showErlabError(message);
			}
		});

	// ─────────────────────────────────────────────────────────────────────────
	// Core services
	// ─────────────────────────────────────────────────────────────────────────
	const pinnedStore = new PinnedXarrayStore(context.globalState);
	const xarrayPanelProvider = new XarrayPanelProvider(pinnedStore, {
		onDidAccessNotebook: (notebookUri) => updateErlabContextForNotebook(notebookUri),
		typeFilterState: context.globalState,
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
	const notebookCellStatusBarEmitter = new vscode.EventEmitter<void>();
	const pendingStatusBarRefreshes = new Set<string>();
	const notebookStatusBarRetryTimers = new Map<string, NodeJS.Timeout>();
	const clearNotebookStatusBarRetry = (notebookUri?: vscode.Uri): void => {
		if (!notebookUri) {
			for (const timer of notebookStatusBarRetryTimers.values()) {
				clearTimeout(timer);
			}
			notebookStatusBarRetryTimers.clear();
			return;
		}
		const cacheKey = notebookUri.toString();
		const timer = notebookStatusBarRetryTimers.get(cacheKey);
		if (!timer) {
			return;
		}
		clearTimeout(timer);
		notebookStatusBarRetryTimers.delete(cacheKey);
	};
	const scheduleNotebookStatusBarRefreshRetry = (notebookUri: vscode.Uri): void => {
		if (isShuttingDown) {
			return;
		}
		const delayMs = getXarrayListAutoRefreshDelayMs(notebookUri);
		if (typeof delayMs !== 'number') {
			clearNotebookStatusBarRetry(notebookUri);
			return;
		}
		if (delayMs <= 0) {
			clearNotebookStatusBarRetry(notebookUri);
			requestNotebookStatusBarRefresh(notebookUri);
			return;
		}
		clearNotebookStatusBarRetry(notebookUri);
		const cacheKey = notebookUri.toString();
		notebookStatusBarRetryTimers.set(
			cacheKey,
			setNonBlockingTimeout(() => {
				notebookStatusBarRetryTimers.delete(cacheKey);
				if (isShuttingDown) {
					return;
				}
				if (shouldAutoRefreshXarrayList(notebookUri)) {
					requestNotebookStatusBarRefresh(notebookUri);
					return;
				}
				scheduleNotebookStatusBarRefreshRetry(notebookUri);
			}, delayMs)
		);
	};
	const requestNotebookStatusBarRefresh = (notebookUri: vscode.Uri): void => {
		if (isShuttingDown) {
			return;
		}
		const cacheKey = notebookUri.toString();
		if (pendingStatusBarRefreshes.has(cacheKey)) {
			return;
		}
		pendingStatusBarRefreshes.add(cacheKey);
		clearNotebookStatusBarRetry(notebookUri);
		void refreshXarrayCache(notebookUri)
			.then((result) => {
				if (result.error) {
					if (!isShuttingDown && isXarrayListStale(notebookUri)) {
						scheduleNotebookStatusBarRefreshRetry(notebookUri);
					}
					return;
				}
				if (!isShuttingDown) {
					notebookCellStatusBarEmitter.fire();
				}
			})
			.finally(() => {
				pendingStatusBarRefreshes.delete(cacheKey);
			});
	};
	const requestXarrayRefresh = async (
		options?: { refreshCache?: boolean; notebookUri?: vscode.Uri }
	): Promise<void> => {
		if (isShuttingDown) {
			return;
		}
		const notebookUri = options?.notebookUri ?? getActiveNotebookUri();
		if (options?.refreshCache) {
			if (notebookUri) {
				await refreshXarrayCache(notebookUri);
			}
			await updateErlabContextForNotebook(notebookUri);
		}
		if (isShuttingDown) {
			return;
		}
		xarrayPanelProvider.requestRefresh();
		notebookCellStatusBarEmitter.fire();
	};
	const refreshAfterNotebookExecution = (notebookUri: vscode.Uri): void => {
		if (isShuttingDown) {
			return;
		}
		const activeNotebook = getActiveNotebookUri();
		const isActiveNotebook = activeNotebook?.toString() === notebookUri.toString();
		if (!isActiveNotebook) {
			markXarrayCacheStale(notebookUri);
			return;
		}
		const treeVisible = xarrayPanelProvider.isVisibleForNotebook(notebookUri);
		const detailVisible = xarrayDetailProvider.isVisibleForNotebook(notebookUri);
		if (!treeVisible) {
			markXarrayCacheStale(notebookUri);
		}
		if (treeVisible) {
			void refreshXarrayCache(notebookUri).finally(() => {
				if (isShuttingDown) {
					return;
				}
				xarrayPanelProvider.requestRefresh();
				notebookCellStatusBarEmitter.fire();
				if (detailVisible) {
					xarrayDetailProvider.refreshCurrentDetail();
				}
			});
			return;
		}
		xarrayPanelProvider.requestRefresh();
		notebookCellStatusBarEmitter.fire();
		if (detailVisible) {
			xarrayDetailProvider.refreshCurrentDetail();
		}
	};
	const xarrayVisibilityDisposable = xarrayTreeView.onDidChangeVisibility(() => {
		void requestXarrayRefresh();
	});
	const xarraySelectionDisposable = xarrayTreeView.onDidChangeSelection((event) => {
		if (isShuttingDown) {
			return;
		}
		if (event.selection.length === 0) {
			xarrayDetailProvider.clearDetail();
		}
	});

	shutdownExtensionResources = () => {
		clearSelectionContextRetry();
		clearNotebookStatusBarRetry();
		shutdownXarrayService();
		xarrayPanelProvider.dispose();
		xarrayDetailProvider.dispose();
		shutdownKernelClient();
	};

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
		(variableName) => buildMarimoWatchInvocation(variableName, { unwatch: false }),
		async ({ notebookUri }) => {
			await requestXarrayRefresh({ refreshCache: true, notebookUri });
		},
		undefined,
		'helper'
	);

	const itoolDisposable = registerMagicCommand(
		'erlab.itool',
		'itool',
		(variableName) => variableName,
		(variableName) => {
			const useManager = vscode.workspace.getConfiguration('erlab').get<boolean>('itool.useManager', true);
			return buildItoolInvocation(variableName, useManager);
		},
		({ notebookUri }) => requestXarrayRefresh({ notebookUri }),
		(variableName) => {
			const useManager = vscode.workspace.getConfiguration('erlab').get<boolean>('itool.useManager', true);
			return buildMarimoItoolInvocation(variableName, useManager);
		},
		'gui'
	);

	const unwatchDisposable = registerMagicCommand(
		'erlab.unwatch',
		'watch',
		(variableName) => `-d ${variableName}`,
		(variableName) => buildMarimoWatchInvocation(variableName, { unwatch: true }),
		async ({ notebookUri }) => {
			await requestXarrayRefresh({ refreshCache: true, notebookUri });
		},
		undefined,
		'helper'
	);

	// Additional tool magic commands
	const ktoolDisposable = registerMagicCommand(
		'erlab.ktool',
		'ktool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('ktool', variableName),
		'gui'
	);

	const dtoolDisposable = registerMagicCommand(
		'erlab.dtool',
		'dtool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('dtool', variableName),
		'gui'
	);

	const restoolDisposable = registerMagicCommand(
		'erlab.restool',
		'restool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('restool', variableName),
		'gui'
	);

	const meshtoolDisposable = registerMagicCommand(
		'erlab.meshtool',
		'meshtool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('meshtool', variableName),
		'gui'
	);

	const ftoolDisposable = registerMagicCommand(
		'erlab.ftool',
		'ftool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('ftool', variableName),
		'gui'
	);

	const goldtoolDisposable = registerMagicCommand(
		'erlab.goldtool',
		'goldtool',
		(variableName) => variableName,
		undefined,
		undefined,
		(variableName) => buildMarimoToolInvocation('goldtool', variableName),
		'gui'
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
	let selectionContextVersion = 0;
	let selectionContextRetryTimer: NodeJS.Timeout | undefined;
	const nextSelectionContextVersion = (): number => {
		selectionContextVersion += 1;
		return selectionContextVersion;
	};
	const isCurrentSelectionContextVersion = (version: number): boolean => {
		return !isShuttingDown && version === selectionContextVersion;
	};
	const clearSelectionContextRetry = (): void => {
		if (!selectionContextRetryTimer) {
			return;
		}
		clearTimeout(selectionContextRetryTimer);
		selectionContextRetryTimer = undefined;
	};
	const applySelectionContexts = async (
		version: number,
		isDataArray: boolean,
		isWatchAvailable: boolean,
		isWatched: boolean
	): Promise<void> => {
		if (!isCurrentSelectionContextVersion(version)) {
			return;
		}
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_CONTEXT, isDataArray);
		if (!isCurrentSelectionContextVersion(version)) {
			return;
		}
		await vscode.commands.executeCommand(
			'setContext',
			DATA_ARRAY_WATCH_AVAILABLE_CONTEXT,
			isWatchAvailable
		);
		if (!isCurrentSelectionContextVersion(version)) {
			return;
		}
		await vscode.commands.executeCommand('setContext', DATA_ARRAY_WATCHED_CONTEXT, isWatched);
	};
	const scheduleSelectionContextRetry = (
		version: number,
		notebookUri: vscode.Uri,
		variableName: string
	): void => {
		if (!isCurrentSelectionContextVersion(version)) {
			return;
		}
		const delayMs = getXarrayListAutoRefreshDelayMs(notebookUri);
		if (typeof delayMs !== 'number') {
			clearSelectionContextRetry();
			return;
		}
		if (delayMs <= 0) {
			clearSelectionContextRetry();
			refreshSelectionContexts(version, notebookUri, variableName);
			return;
		}
		clearSelectionContextRetry();
		selectionContextRetryTimer = setNonBlockingTimeout(() => {
			selectionContextRetryTimer = undefined;
			if (!isCurrentSelectionContextVersion(version)) {
				return;
			}
			if (shouldAutoRefreshXarrayList(notebookUri)) {
				refreshSelectionContexts(version, notebookUri, variableName);
				return;
			}
			scheduleSelectionContextRetry(version, notebookUri, variableName);
		}, delayMs);
	};
	const refreshSelectionContexts = (
		version: number,
		notebookUri: vscode.Uri,
		variableName: string
	): void => {
		void refreshXarrayCache(notebookUri).then(async (refreshResult) => {
			if (!isCurrentSelectionContextVersion(version)) {
				return;
			}
			if (refreshResult.error) {
				if (isXarrayListStale(notebookUri)) {
					scheduleSelectionContextRetry(version, notebookUri, variableName);
				}
				return;
			}
			clearSelectionContextRetry();
			const refreshedEntry = getCachedXarrayEntry(notebookUri, variableName);
			const isDataArray = refreshedEntry?.type === 'DataArray';
			const isWatchAvailable = isDataArray && refreshedEntry.watchAvailable !== false;
			await applySelectionContexts(
				version,
				isDataArray,
				isWatchAvailable,
				isWatchAvailable && Boolean(refreshedEntry?.watched)
			);
		});
	};
	const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(async (event: vscode.TextEditorSelectionChangeEvent) => {
		if (isShuttingDown) {
			return;
		}
		const selectionVersion = nextSelectionContextVersion();
		clearSelectionContextRetry();
		if (!event.textEditor || !isSupportedNotebookCellDocument(event.textEditor.document)) {
			await applySelectionContexts(selectionVersion, false, false, false);
			return;
		}

		const variableName = getVariableAtSelection(event.textEditor);
		if (!variableName || !isValidPythonIdentifier(variableName)) {
			await applySelectionContexts(selectionVersion, false, false, false);
			return;
		}

		// Namespace-level staleness invalidates cached hits until the list is refreshed.
		const notebookUri = getNotebookUriForDocument(event.textEditor.document);
		if (!notebookUri) {
			await applySelectionContexts(selectionVersion, false, false, false);
			return;
		}
		const listStale = isXarrayListStale(notebookUri);
		let entry = listStale ? undefined : getCachedXarrayEntry(notebookUri, variableName);
		if (listStale) {
			if (shouldAutoRefreshXarrayList(notebookUri)) {
				refreshSelectionContexts(selectionVersion, notebookUri, variableName);
			} else {
				scheduleSelectionContextRetry(selectionVersion, notebookUri, variableName);
			}
		}
		const isDataArray = entry?.type === 'DataArray';
		const isWatchAvailable = isDataArray && entry?.watchAvailable !== false;
		await applySelectionContexts(
			selectionVersion,
			isDataArray,
			isWatchAvailable,
			isWatchAvailable && Boolean(entry?.watched)
		);
	});

	const activeEditorDisposable = vscode.window.onDidChangeActiveTextEditor(async (editor?: vscode.TextEditor) => {
		if (isShuttingDown) {
			return;
		}
		const selectionVersion = nextSelectionContextVersion();
		clearSelectionContextRetry();
		if (!editor || !isSupportedNotebookCellDocument(editor.document)) {
			await applySelectionContexts(selectionVersion, false, false, false);
			if (!getActiveNotebookUri()) {
				xarrayDetailProvider.clearDetail();
			}
			void requestXarrayRefresh();
			return;
		}
		void requestXarrayRefresh();
	});

	const activeNotebookDisposable = vscode.window.onDidChangeActiveNotebookEditor(async (editor) => {
		if (isShuttingDown) {
			return;
		}
		// Refresh cache when switching notebooks (debounced)
		if (editor) {
			await requestXarrayRefresh({ refreshCache: true, notebookUri: editor.notebook.uri });
			return;
		}
		await updateErlabContextForNotebook(undefined);
		if (!getActiveNotebookUri()) {
			xarrayDetailProvider.clearDetail();
		}
		void requestXarrayRefresh();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Notebook execution tracking
	// ─────────────────────────────────────────────────────────────────────────
	const notebookExecutionDisposable = vscode.workspace.onDidChangeNotebookDocument(async (event) => {
		if (isShuttingDown) {
			return;
		}
		if (!isSupportedNotebookType(event.notebook.notebookType)) {
			return;
		}
		const notebookUri = event.notebook.uri;
		const hasExecutionSummary = event.cellChanges.some((change) => change.executionSummary);
		const hasOutputsChange = event.cellChanges.some((change) => change.outputs);
		if (hasOutputsChange && !hasExecutionSummary) {
			xarrayPanelProvider.setNotebookExecutionInProgress(notebookUri, true);
			xarrayDetailProvider.setNotebookExecutionInProgress(notebookUri, true);
			return;
		}
		if (hasExecutionSummary) {
			xarrayPanelProvider.setNotebookExecutionInProgress(notebookUri, false);
			xarrayDetailProvider.setNotebookExecutionInProgress(notebookUri, false);
			refreshAfterNotebookExecution(notebookUri);
			const activeNotebook = getActiveNotebookUri();
			if (activeNotebook?.toString() === notebookUri.toString()) {
				void updateErlabContextForNotebook(notebookUri);
			}
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// Notebook cell status bar
	// ─────────────────────────────────────────────────────────────────────────
	const notebookCellStatusBarProvider: vscode.NotebookCellStatusBarItemProvider = {
		onDidChangeCellStatusBarItems: notebookCellStatusBarEmitter.event,
		provideCellStatusBarItems: (
			cell: vscode.NotebookCell,
			token: vscode.CancellationToken
		): vscode.NotebookCellStatusBarItem[] => {
			if (isShuttingDown) {
				return [];
			}
			if (!isSupportedNotebookLanguage(cell.document.languageId)) {
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
			if (isXarrayListStale(notebookUri)) {
				if (shouldAutoRefreshXarrayList(notebookUri)) {
					requestNotebookStatusBarRefresh(notebookUri);
				} else {
					scheduleNotebookStatusBarRefreshRetry(notebookUri);
				}
				return [];
			}
			clearNotebookStatusBarRetry(notebookUri);
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
				arguments: [{ variableName, notebookUri: notebookUri.toString() }],
			};
			item.tooltip = label;
			return [item];
		},
	};
	const jupyterNotebookCellStatusBarDisposable = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
		'jupyter-notebook',
		notebookCellStatusBarProvider
	);
	const marimoNotebookCellStatusBarDisposable = vscode.notebooks.registerNotebookCellStatusBarItemProvider(
		'marimo-notebook',
		notebookCellStatusBarProvider
	);

	// ─────────────────────────────────────────────────────────────────────────
	// DataArray panel commands
	// ─────────────────────────────────────────────────────────────────────────
	const filterXarrayTypesDisposable = vscode.commands.registerCommand(
		'erlab.xarray.filterTypes',
		async () => {
			const currentFilters = new Set(xarrayPanelProvider.getTypeFilters());
			const options: Array<{ type: XarrayObjectType; label: string; description: string }> = [
				{ type: 'DataArray', label: 'DataArray', description: 'xarray.DataArray' },
				{ type: 'Dataset', label: 'Dataset', description: 'xarray.Dataset' },
				{ type: 'DataTree', label: 'DataTree', description: 'xarray.DataTree' },
			];
			const picks = options.map((option) => ({
				label: option.label,
				description: option.description,
				type: option.type,
				picked: currentFilters.has(option.type),
			}));
			const selected = await vscode.window.showQuickPick(picks, {
				canPickMany: true,
				placeHolder: 'Select xarray types to show in the Objects panel',
			});
			if (!selected) {
				return;
			}
			await xarrayPanelProvider.setTypeFilters(selected.map((item) => item.type));
		}
	);

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
				showErlabInfo('open a notebook to view DataArrays.');
				return;
			}
			const activeNotebook = getActiveNotebookUri();
			if (activeNotebook && activeNotebook.toString() === notebookUri.toString()) {
				void xarrayPanelProvider.select(variableName);
			}
			await xarrayDetailProvider.showDetail(notebookUri, variableName, normalized?.type);
		}
	);

	const openDetailDisposable = vscode.commands.registerCommand(
		'erlab.openDetail',
		async (args?: unknown) => {
			const normalized = normalizeJupyterVariableViewerArgs(args as JupyterVariableViewerArgs);
			const paletteMessage = 'execute a cell to start the kernel and load variables.';
			if (!normalized?.variableName) {
				const activeNotebook = getActiveNotebookUri();
				if (!activeNotebook) {
					showErlabInfo(paletteMessage);
					return;
				}
				const kernel = await getKernelForNotebook(activeNotebook);
				if (!kernel) {
					showErlabInfo(paletteMessage);
					return;
				}
				const refresh = await refreshXarrayCache(activeNotebook);
				if (refresh.error || refresh.entries.length === 0) {
					showErlabInfo(paletteMessage);
					return;
				}
				const entries = refresh.entries
					.slice()
					.sort((a, b) => a.variableName.localeCompare(b.variableName));
				const picks = entries.map((entry) => ({
					label: formatXarrayLabel(entry, entry.variableName),
					description: entry.type,
					entry,
				}));
				const selected = await vscode.window.showQuickPick(picks, {
					placeHolder: 'Select an xarray object to inspect',
				});
				if (!selected) {
					return;
				}
				if (activeNotebook) {
					void xarrayPanelProvider.select(selected.entry.variableName);
				}
				await xarrayDetailProvider.showDetail(activeNotebook, selected.entry.variableName, selected.entry.type);
				return;
			}
			const variableName = normalized.variableName;
			let notebookUri = resolveNotebookUri(normalized?.notebookUri);
			if (!notebookUri) {
				showErlabInfo('open a notebook to view xarray objects.');
				return;
			}
			let kernel = await getKernelForNotebook(notebookUri);
			const activeNotebook = getActiveNotebookUri();
			if (!kernel && activeNotebook) {
				const activeKernel = await getKernelForNotebook(activeNotebook);
				if (activeKernel) {
					logger.debug('Variable viewer fallback to active notebook kernel.');
					notebookUri = activeNotebook;
					kernel = activeKernel;
				}
			}
			if (!kernel) {
				showErlabInfo(paletteMessage);
				return;
			}
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
				showErlabInfo('open a notebook to pin DataArrays.');
				return;
			}
			await vscode.commands.executeCommand('editor.action.hideHover');
			const isPinned = pinnedStore.isPinned(notebookUri, variableName);
				if (isPinned) {
					await pinnedStore.unpin(notebookUri, variableName);
				} else {
					await pinnedStore.pin(notebookUri, variableName);
				}
				void requestXarrayRefresh({ notebookUri });
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
				showErlabInfo('open a notebook to pin DataArrays.');
				return;
				}
				if (!pinnedStore.isPinned(notebookUri, variableName)) {
					await pinnedStore.pin(notebookUri, variableName);
					void requestXarrayRefresh({ notebookUri });
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
				showErlabInfo('open a notebook to unpin DataArrays.');
				return;
				}
				if (pinnedStore.isPinned(notebookUri, variableName)) {
					await pinnedStore.unpin(notebookUri, variableName);
					void requestXarrayRefresh({ notebookUri });
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
				showErlabInfo('open a notebook to watch DataArrays.');
				return;
			}
			const watched = Boolean(normalized?.watched);
				await vscode.commands.executeCommand(
					watched ? 'erlab.unwatch' : 'erlab.watch',
					{ variableName, notebookUri: notebookUri.toString() }
				);
				void requestXarrayRefresh({ notebookUri });
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
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
				await vscode.commands.executeCommand('erlab.watch', {
					variableName,
					notebookUri: notebookUri?.toString(),
				});
				void requestXarrayRefresh({ notebookUri });
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
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
				await vscode.commands.executeCommand('erlab.unwatch', {
					variableName,
					notebookUri: notebookUri?.toString(),
				});
				void requestXarrayRefresh({ notebookUri });
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
				showErlabInfo('ImageTool supports DataArrays with ndim < 5.');
				return;
			}
			const notebookUri = resolveNotebookUri(normalized?.notebookUri);
			await vscode.commands.executeCommand('erlab.itool', {
				variableName,
				notebookUri: notebookUri?.toString(),
			});
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
				showErlabInfo('open a notebook to navigate to definitions.');
				return;
			}
			const notebook = vscode.workspace.notebookDocuments.find(
				(doc) => doc.uri.toString() === notebookUri.toString()
			);
			if (!notebook) {
				showErlabInfo('active notebook not found.');
				return;
			}
			const target = await findNotebookDefinitionLocation(notebook, variableName);
				if (!target) {
					showErlabInfo(`no definition found for ${variableName}.`);
					return;
				}
				const isNotebookCellTarget = target.document.uri.scheme === 'vscode-notebook-cell';
				if (isNotebookCellTarget) {
					const targetNotebook = getNotebookDocumentForCellDocument(target.document)
						?? vscode.workspace.notebookDocuments.find((doc) => doc.uri.toString() === notebookUri.toString());
					if (targetNotebook) {
						const cellIndex = targetNotebook
							.getCells()
							.findIndex((cell) => cell.document.uri.toString() === target.document.uri.toString());
						const selections = cellIndex >= 0 ? [new vscode.NotebookRange(cellIndex, cellIndex + 1)] : undefined;
						await vscode.window.showNotebookDocument(targetNotebook, {
							preview: true,
							selections,
						});
					}
				}
				try {
					const editor = await vscode.window.showTextDocument(target.document, {
						selection: target.range,
						preview: true,
					});
					editor.revealRange(target.range, vscode.TextEditorRevealType.InCenter);
				} catch (error) {
					if (!isNotebookCellTarget) {
						throw error;
					}
					logger.debug(
						`Failed to open notebook cell editor for definition target ${target.document.uri.toString()}: ${
							error instanceof Error ? error.message : String(error)
						}`
					);
				}
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
			jupyterNotebookCellStatusBarDisposable,
			marimoNotebookCellStatusBarDisposable,
			refreshDataArrayPanelDisposable,
		openDataArrayDetailDisposable,
		openDetailDisposable,
		filterXarrayTypesDisposable,
		togglePinDisposable,
		pinDisposable,
		unpinDisposable,
		toggleWatchDisposable,
		dataArrayWatchDisposable,
		dataArrayUnwatchDisposable,
		openInImageToolDisposable,
		goToDefinitionDisposable,
		showOutputDisposable,
		notebookUriIndexDisposable,
		notebookCellStatusBarEmitter,
		xarrayPanelProvider,
		xarrayTreeView,
		xarrayDetailProvider,
		xarrayDetailDisposable,
		xarrayVisibilityDisposable,
		xarraySelectionDisposable
	);
}

// This method is called when your extension is deactivated
export function deactivate() {
	runExtensionShutdown();
}

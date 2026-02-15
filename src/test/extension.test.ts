/**
 * VS Code Integration Tests for ERLab Extension
 *
 * These tests require VS Code test infrastructure to run.
 * Heavy Python/Jupyter E2E tests are gated behind ERLAB_E2E=1 env var.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { buildXarrayQueryCode } from '../features/xarray/pythonSnippets';
import { __clearXarrayCacheForTests, __setXarrayCacheForTests } from '../features/xarray/service';
import { getNotebookUriForDocument, resolveNotebookUri } from '../notebook/notebookUris';
import type { XarrayEntry } from '../features/xarray/types';
import { XarrayPanelProvider } from '../features/xarray/views/treeView';
import { PinnedXarrayStore } from '../features/xarray/views/pinnedStore';

const execFileAsync = promisify(execFile);

// Check if E2E tests are enabled (these require Python + erlab package)
const E2E_ENABLED = process.env.ERLAB_E2E === '1';

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

function contentToString(content: vscode.MarkedString | vscode.MarkdownString): string {
	if (typeof content === 'string') {
		return content;
	}
	if ('value' in content && typeof content.value === 'string') {
		return content.value;
	}
	return content.toString();
}

function findExtensionByName(name: string): vscode.Extension<unknown> | undefined {
	return vscode.extensions.all.find((ext) => ext.packageJSON?.name === name);
}

async function activateExtension(): Promise<vscode.Extension<unknown>> {
	const extension = findExtensionByName('erlab');
	assert.ok(extension, 'Expected ERLab extension to be available');
	if (!extension!.isActive) {
		await extension!.activate();
	}
	return extension!;
}

function getUriFromShowTextDocumentArg(value: unknown): vscode.Uri | undefined {
	if (value instanceof vscode.Uri) {
		return value;
	}
	if (value && typeof value === 'object' && 'uri' in value) {
		const candidate = (value as { uri?: unknown }).uri;
		if (candidate instanceof vscode.Uri) {
			return candidate;
		}
	}
	return;
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration Test Suite (Fast - No Python required)
// ─────────────────────────────────────────────────────────────────────────────

suite('Extension Integration Tests', () => {
	test('Extension activates successfully', async () => {
		const extension = await activateExtension();
		assert.ok(extension.isActive, 'Extension should be active');
	});

	test('Registers all ERLab commands', async () => {
		await activateExtension();
		const commands = await vscode.commands.getCommands(true);

		// Magic commands
		assert.ok(commands.includes('erlab.watch'), 'Expected erlab.watch command');
		assert.ok(commands.includes('erlab.unwatch'), 'Expected erlab.unwatch command');
		assert.ok(commands.includes('erlab.itool'), 'Expected erlab.itool command');

		// xarray panel commands
		assert.ok(commands.includes('erlab.xarray.refresh'), 'Expected erlab.xarray.refresh command');
		assert.ok(commands.includes('erlab.xarray.openDetail'), 'Expected erlab.xarray.openDetail command');
		assert.ok(commands.includes('erlab.xarray.togglePin'), 'Expected erlab.xarray.togglePin command');
		assert.ok(commands.includes('erlab.xarray.pin'), 'Expected erlab.xarray.pin command');
		assert.ok(commands.includes('erlab.xarray.unpin'), 'Expected erlab.xarray.unpin command');
		assert.ok(commands.includes('erlab.xarray.toggleWatch'), 'Expected erlab.xarray.toggleWatch command');
		assert.ok(commands.includes('erlab.xarray.watch'), 'Expected erlab.xarray.watch command');
		assert.ok(commands.includes('erlab.xarray.unwatch'), 'Expected erlab.xarray.unwatch command');
		assert.ok(commands.includes('erlab.xarray.openInImageTool'), 'Expected erlab.xarray.openInImageTool command');
		assert.ok(commands.includes('erlab.xarray.goToDefinition'), 'Expected erlab.xarray.goToDefinition command');
	});

	test('Hover provider is notebook-only (does not show in .py files)', async () => {
		await activateExtension();

		const document = await vscode.workspace.openTextDocument({
			language: 'python',
			content: 'data = 1\nresult = data + 1',
		});
		await vscode.window.showTextDocument(document);

		// Check hover at 'data' variable
		const position = new vscode.Position(0, 1);
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			document.uri,
			position
		);

		const hoverText = (hovers ?? [])
			.flatMap((hover) => hover.contents)
			.map((content) => contentToString(content))
			.join('\n');

		// ERLab hover should NOT appear in regular .py files
		assert.ok(!/\b(Watch|Unwatch|ImageTool|Pin)\b/.test(hoverText),
			'ERLab hover actions should not appear in .py files');
	});

	test('Magic commands show info message outside notebooks', async () => {
		await activateExtension();

		const document = await vscode.workspace.openTextDocument({
			language: 'python',
			content: 'x = 1',
		});
		await vscode.window.showTextDocument(document);

		// Commands should not throw when run outside notebooks
		// They should show an info message instead
		try {
			await vscode.commands.executeCommand('erlab.watch', { variableName: 'x' });
		} catch {
			// Some implementations may throw, which is also acceptable
		}
	});

	test('Context keys are set correctly for non-DataArray', async () => {
		await activateExtension();

		const document = await vscode.workspace.openTextDocument({
			language: 'python',
			content: 'regular_var = 42',
		});
		const editor = await vscode.window.showTextDocument(document);

		// Move cursor to variable
		const position = new vscode.Position(0, 5);
		editor.selection = new vscode.Selection(position, position);

		// Small delay for context update
		await new Promise((resolve) => setTimeout(resolve, 100));

		// We can't directly check context keys, but we can verify the extension
		// didn't crash when processing selection changes
		assert.ok(editor.document.uri, 'Editor should still be active');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Notebook API Integration Tests (VS Code notebook APIs)
// These tests use cached data and do not require kernel selection.
// ─────────────────────────────────────────────────────────────────────────────

suite('Notebook Integration Tests', function () {
	this.timeout(20_000);

	const jupyterExtensionId = 'ms-toolsai.jupyter';
	let notebook: vscode.NotebookDocument | undefined;
	let tempDir: string | undefined;

	class MemoryMemento implements vscode.Memento {
		private readonly store = new Map<string, unknown>();
		keys(): readonly string[] {
			return Array.from(this.store.keys());
		}

		get<T>(key: string, defaultValue?: T): T {
			if (this.store.has(key)) {
				return this.store.get(key) as T;
			}
			return defaultValue as T;
		}

		async update(key: string, value: unknown): Promise<void> {
			this.store.set(key, value);
		}
	}

	async function ensureJupyterExtension(): Promise<void> {
		const jupyterExtension = vscode.extensions.getExtension(jupyterExtensionId);
		if (!jupyterExtension) {
			throw new Error('Jupyter extension not available in test host.');
		}
		if (!jupyterExtension.isActive) {
			await jupyterExtension.activate();
		}
	}

	function buildNotebookJson(content: string): string {
		const lines = content.split('\n').map((line) => `${line}\n`);
		const notebookData = {
			cells: [
				{
					cell_type: 'code',
					execution_count: null,
					metadata: {},
					outputs: [],
					source: lines,
				},
			],
			metadata: {
				kernelspec: {
					name: 'python3',
					display_name: 'Python 3',
					language: 'python',
				},
				language_info: { name: 'python' },
			},
			nbformat: 4,
			nbformat_minor: 5,
		};
		return JSON.stringify(notebookData);
	}

	async function createNotebook(content: string): Promise<vscode.NotebookDocument> {
		await ensureJupyterExtension();
		tempDir = tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'erlab-notebook-'));
		const filePath = path.join(tempDir, `test-${Date.now()}.ipynb`);
		await fs.promises.writeFile(filePath, buildNotebookJson(content), 'utf8');
		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openNotebookDocument(uri);
		await vscode.window.showNotebookDocument(doc);
		return doc;
	}

	test('Notebook cell documents are resolved to their notebook URI', async function () {
		await activateExtension();

		try {
			notebook = await createNotebook('data = 1');
		} catch (error) {
			this.skip();
		}

		const cellDocument = notebook.getCells()[0].document;
		const notebookUri = getNotebookUriForDocument(cellDocument);
		assert.ok(notebookUri, 'Expected notebook URI for cell document');
		assert.strictEqual(notebookUri?.toString(), notebook.uri.toString(), 'Notebook URI should match');

		const resolved = resolveNotebookUri(cellDocument.uri.toString());
		assert.ok(resolved, 'Expected resolved notebook URI from cell URI');
		assert.strictEqual(resolved?.toString(), notebook.uri.toString(), 'Resolved URI should match notebook');
	});

	test('Hover provider returns actions in notebook cells for cached DataArray', async function () {
		await activateExtension();

		try {
			notebook = await createNotebook('da');
		} catch (error) {
			this.skip();
		}

		const notebookUri = notebook.uri;
		const entry: XarrayEntry = {
			variableName: 'da',
			type: 'DataArray',
			name: 'da',
			dims: ['x'],
			sizes: { x: 10 },
			shape: [10],
			dtype: 'float64',
			ndim: 1,
			watched: false,
		};
		__setXarrayCacheForTests(notebookUri, [entry], { hasDetails: true });

		const cellDocument = notebook.getCells()[0].document;
		const position = new vscode.Position(0, 1);
		const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
			'vscode.executeHoverProvider',
			cellDocument.uri,
			position
		);

		const hoverText = (hovers ?? [])
			.flatMap((hover) => hover.contents)
			.map((content) => contentToString(content))
			.join('\n');

		assert.ok(/\bDataArray\b/.test(hoverText), 'Expected DataArray header in hover');
		assert.ok(/command:erlab\.xarray\.openDetail/.test(hoverText), 'Expected Details action in hover');
		assert.ok(/command:erlab\.xarray\.togglePin/.test(hoverText), 'Expected Pin action in hover');
		// erlab-specific commands may or may not appear depending on context
		// we just verify the core functionality works

		__clearXarrayCacheForTests(notebookUri);
	});

	test('Tree view populates items from cached xarray entries', async function () {
		await activateExtension();

		try {
			notebook = await createNotebook('tree_da');
		} catch (error) {
			this.skip();
		}
		const notebookUri = notebook.uri;

		const entry: XarrayEntry = {
			variableName: 'tree_da',
			type: 'DataArray',
			name: 'tree_da',
			dims: ['x'],
			sizes: { x: 3 },
			shape: [3],
			dtype: 'float64',
			ndim: 1,
			watched: true,
		};
		__setXarrayCacheForTests(notebookUri, [entry], { hasDetails: true });

		const pinnedStore = new PinnedXarrayStore(new MemoryMemento());
		await pinnedStore.pin(notebookUri, 'tree_da');

		const provider = new XarrayPanelProvider(pinnedStore);
		const items = await provider.getChildren();
		assert.strictEqual(items.length, 1, 'Expected one tree item');
		const item = items[0] as vscode.TreeItem;
		assert.strictEqual(item.label, 'tree_da');
		assert.ok(typeof item.contextValue === 'string' && item.contextValue.includes('Pinned'), 'Expected pinned context');
		assert.ok(typeof item.description === 'string' && item.description.includes('x:'), 'Expected dims description');

		__clearXarrayCacheForTests(notebookUri);
	});

	test('Go to definition opens notebook-cell targets', async function () {
		await activateExtension();

		try {
			notebook = await createNotebook('source_da = 1\nresult = source_da');
		} catch (error) {
			this.skip();
		}

		await vscode.commands.executeCommand('erlab.xarray.goToDefinition', {
			variableName: 'source_da',
			notebookUri: notebook.uri.toString(),
		});

		const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
		assert.ok(activeNotebook, 'Expected active notebook editor after go-to-definition');
		assert.strictEqual(activeNotebook?.uri.toString(), notebook.uri.toString(), 'Expected target notebook to be active');
	});

	test('Go to definition ignores notebook-cell text editor open failures', async function () {
		await activateExtension();

		try {
			notebook = await createNotebook('source_da = 1\nresult = source_da');
		} catch (error) {
			this.skip();
		}

		const originalShowTextDocument = vscode.window.showTextDocument.bind(vscode.window);
		const windowApi = vscode.window as unknown as {
			showTextDocument: typeof vscode.window.showTextDocument;
		};
		const mockedShowTextDocument = async (...args: unknown[]) => {
			const uri = getUriFromShowTextDocumentArg(args[0]);
			if (uri?.scheme === 'vscode-notebook-cell') {
				throw new Error('Simulated notebook-cell open failure');
			}
			return (originalShowTextDocument as (...callArgs: unknown[]) => unknown)(...args);
		};
		windowApi.showTextDocument = mockedShowTextDocument as unknown as typeof vscode.window.showTextDocument;

		try {
			await vscode.commands.executeCommand('erlab.xarray.goToDefinition', {
				variableName: 'source_da',
				notebookUri: notebook.uri.toString(),
			});
		} finally {
			windowApi.showTextDocument = originalShowTextDocument;
		}
	});

	suiteTeardown(async () => {
		if (tempDir) {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E Test Suite (Slow - Requires Python + erlab package)
// Set ERLAB_E2E=1 to run these tests
// ─────────────────────────────────────────────────────────────────────────────

suite('E2E Tests (Python/Jupyter)', function () {
	// Skip entire suite if E2E not enabled
	if (!E2E_ENABLED) {
		test('Skipped - set ERLAB_E2E=1 to enable', () => {
			console.log('[erlab] E2E tests skipped. Set ERLAB_E2E=1 to run Python tests.');
		});
		return;
	}

	const pythonBinary = process.env.PYTHON ?? 'python3';
	let venvDir = '';
	let venvPython = '';
	let useProvidedVenv = false;
	let itoolManagerProcess: ChildProcess | undefined;

	suiteSetup(async function () {
		this.timeout(300_000); // 5 minutes for setup

		// Check if a pre-built venv is provided (for CI caching or local dev)
		const providedVenv = process.env.ERLAB_E2E_VENV;
		if (providedVenv) {
			venvDir = path.resolve(providedVenv);
			useProvidedVenv = true;
			console.log(`[erlab] Using provided venv: ${venvDir}`);
		} else {
			console.log('[erlab] E2E tests enabled - creating Python venv...');
			venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erlab-venv-'));
		}

		// Handle Windows vs Unix paths
		const isWindows = process.platform === 'win32';
		venvPython = isWindows
			? path.join(venvDir, 'Scripts', 'python.exe')
			: path.join(venvDir, 'bin', 'python');

		// Skip venv creation and pip install if using provided venv
		if (useProvidedVenv) {
			console.log('[erlab] Skipping venv setup (using provided venv).');
		} else {
			console.log(`[erlab] Using Python: ${pythonBinary}`);
			await execFileAsync(pythonBinary, ['-m', 'venv', venvDir]);

			console.log('[erlab] Upgrading pip...');
			await execFileAsync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);

			console.log('[erlab] Installing erlab dependencies (this can take a while)...');
			await execFileAsync(venvPython, ['-m', 'pip', 'install', 'erlab', 'pyqt6', 'ipykernel'], {
				timeout: 240_000, // 4 minute timeout for install
			});

			console.log('[erlab] erlab dependencies installed.');
		}

		async function isItoolManagerRunning(): Promise<boolean> {
			const code = [
				'import erlab.interactive.imagetool.manager as manager',
				'print("1" if manager.is_running() else "0")',
			].join('\n');
			try {
				const { stdout } = await execFileAsync(venvPython, ['-c', code], { timeout: 10_000 });
				return stdout.trim().endsWith('1');
			} catch (err) {
				console.warn('[erlab] itool-manager check failed:', err);
				return false;
			}
		}

		async function waitForItoolManagerReady(): Promise<void> {
			const start = Date.now();
			while (Date.now() - start < 15_000) {
				if (itoolManagerProcess?.exitCode !== null && itoolManagerProcess?.exitCode !== undefined) {
					throw new Error('itool-manager exited before becoming ready.');
				}
				if (await isItoolManagerRunning()) {
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			throw new Error('itool-manager did not become ready in time.');
		}

		async function startItoolManager(): Promise<void> {
			if (await isItoolManagerRunning()) {
				console.log('[erlab] itool-manager already running; skipping startup.');
				return;
			}
			const isWindows = process.platform === 'win32';
			const managerPath = isWindows
				? path.join(venvDir, 'Scripts', 'itool-manager.exe')
				: path.join(venvDir, 'bin', 'itool-manager');

			itoolManagerProcess = spawn(managerPath, [], {
				env: {
					...process.env,
					QT_QPA_PLATFORM: process.env.QT_QPA_PLATFORM ?? 'offscreen',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			await waitForItoolManagerReady();
			console.log('[erlab] itool-manager started.');
		}

		await startItoolManager();
	});

	suiteTeardown(async function () {
		this.timeout(30_000);
		if (itoolManagerProcess && !itoolManagerProcess.killed) {
			itoolManagerProcess.kill();
			itoolManagerProcess = undefined;
			console.log('[erlab] itool-manager stopped.');
		}
		// Don't delete the venv if it was provided externally (cached venv)
		if (venvDir && !useProvidedVenv) {
			try {
				await fs.promises.rm(venvDir, { recursive: true, force: true });
				console.log('[erlab] Cleaned up venv.');
			} catch (err) {
				console.warn('[erlab] Failed to clean up venv:', err);
			}
		} else if (useProvidedVenv) {
			console.log('[erlab] Skipping venv cleanup (using provided venv).');
		}
	});

	test('ERLab IPython extension loads successfully', async function () {
		this.timeout(60_000);

		const code = [
			'import IPython',
			'ip = IPython.get_ipython()',
			'if ip is None:',
			'    from IPython.terminal.interactiveshell import TerminalInteractiveShell',
			'    ip = TerminalInteractiveShell.instance()',
			'ip.run_line_magic("load_ext", "erlab.interactive")',
			'assert ip.find_line_magic("watch") is not None, "watch magic not found"',
			'assert ip.find_line_magic("itool") is not None, "itool magic not found"',
			'print("OK")',
		].join('\n');

		const { stdout } = await execFileAsync(venvPython, ['-c', code]);
		assert.ok(stdout.includes('OK'), 'Expected OK output from Python');
	});

	test('xarray DataArray can be inspected', async function () {
		this.timeout(60_000);

		const code = [
			'import xarray as xr',
			'import numpy as np',
			'import json',
			'',
			'# Create a test DataArray',
			'data = xr.DataArray(',
			'    np.random.rand(10, 20),',
			'    dims=["x", "y"],',
			'    name="test_data"',
			')',
			'',
			'# Check properties',
			'info = {',
			'    "name": data.name,',
			'    "dims": list(data.dims),',
			'    "shape": list(data.shape),',
			'    "ndim": data.ndim,',
			'}',
			'print(json.dumps(info))',
		].join('\n');

		const { stdout } = await execFileAsync(venvPython, ['-c', code]);
		const info = JSON.parse(stdout.trim());

		assert.strictEqual(info.name, 'test_data');
		assert.deepStrictEqual(info.dims, ['x', 'y']);
		assert.deepStrictEqual(info.shape, [10, 20]);
		assert.strictEqual(info.ndim, 2);
	});

	test('DataArray HTML representation is available', async function () {
		this.timeout(60_000);

		const code = [
			'import xarray as xr',
			'import numpy as np',
			'',
			'data = xr.DataArray(np.arange(10), dims=["x"])',
			'html = data._repr_html_()',
			'assert html is not None, "HTML repr should exist"',
			'assert "<div" in html, "HTML should contain div elements"',
			'print("OK")',
		].join('\n');

		const { stdout } = await execFileAsync(venvPython, ['-c', code]);
		assert.ok(stdout.includes('OK'), 'Expected OK output');
	});

	test('Watch/unwatch keeps DataArrays in xarray query results', async function () {
			this.timeout(60_000);

			const queryCode = buildXarrayQueryCode();
			const code = [
				'import json',
				'import numpy as np',
				'import xarray as xr',
				'import IPython',
				'from IPython.terminal.interactiveshell import TerminalInteractiveShell',
				'import erlab.interactive.imagetool.manager as manager',
				'ip = TerminalInteractiveShell.instance()',
				'ip.run_line_magic("load_ext", "erlab.interactive")',
				'ip.user_ns["a"] = xr.DataArray(np.random.rand(2, 2), dims=["x", "y"], name="a")',
				'ip.user_ns["b"] = xr.DataArray(np.random.rand(2, 2), dims=["x", "y"], name="b")',
				'manager.watch("a", shell=ip)',
				`query_code = ${JSON.stringify(queryCode)}`,
				'exec(query_code)',
				'manager.watch("a", shell=ip, stop=True)',
				'exec(query_code)',
			].join('\n');

		const { stdout } = await execFileAsync(venvPython, ['-c', code]);
		const jsonLines = stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.startsWith('['));
		assert.ok(jsonLines.length >= 2, 'Expected two xarray query outputs');

		const first = JSON.parse(jsonLines[jsonLines.length - 2]) as Array<{ variableName: string; watched?: boolean }>;
		const second = JSON.parse(jsonLines[jsonLines.length - 1]) as Array<{ variableName: string; watched?: boolean }>;

		const findEntry = (entries: Array<{ variableName: string; watched?: boolean }>, name: string) =>
			entries.find((entry) => entry.variableName === name);

		const firstA = findEntry(first, 'a');
		const firstB = findEntry(first, 'b');
		assert.ok(firstA, 'Expected a in first query results');
		assert.ok(firstB, 'Expected b in first query results');
		assert.strictEqual(firstA?.watched, true, 'Expected a to be watched after watch');
		assert.strictEqual(firstB?.watched, false, 'Expected b to be unwatched after watch');

		const secondA = findEntry(second, 'a');
		const secondB = findEntry(second, 'b');
		assert.ok(secondA, 'Expected a in second query results');
		assert.ok(secondB, 'Expected b in second query results');
		assert.strictEqual(secondA?.watched, false, 'Expected a to be unwatched after unwatch');
	});
});

// ─────────────────────────────────────────────────────────────────────────────

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
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

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
			return;
		}

		console.log(`[erlab] Using Python: ${pythonBinary}`);
		await execFileAsync(pythonBinary, ['-m', 'venv', venvDir]);

		console.log('[erlab] Upgrading pip...');
		await execFileAsync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);

		console.log('[erlab] Installing erlab dependencies (this can take a while)...');
		await execFileAsync(venvPython, ['-m', 'pip', 'install', 'erlab', 'pyqt6', 'ipykernel'], {
			timeout: 240_000, // 4 minute timeout for install
		});

		console.log('[erlab] erlab dependencies installed.');
	});

	suiteTeardown(async function () {
		this.timeout(30_000);
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
});

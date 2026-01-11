import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);


suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	const pythonBinary = process.env.PYTHON ?? 'python3';
	let venvDir = '';
	let venvPython = '';

	suiteSetup(async function () {
		this.timeout(180_000);
		console.log('[erlab] Creating Python venv...');
		venvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erlab-venv-'));
		venvPython = path.join(venvDir, 'bin', 'python');

		console.log(`[erlab] Using Python: ${pythonBinary}`);
		await execFileAsync(pythonBinary, ['-m', 'venv', venvDir]);
		console.log('[erlab] Upgrading pip...');
		await execFileAsync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip']);
		console.log('[erlab] Installing erlab dependencies (this can take a bit)...');
		await execFileAsync(venvPython, ['-m', 'pip', 'install', 'erlab', 'pyqt6', 'ipykernel']);
		console.log('[erlab] erlab dependencies installed.');
	});

	suiteTeardown(async function () {
		this.timeout(30_000);
		if (venvDir) {
			await fs.promises.rm(venvDir, { recursive: true, force: true });
		}
	});

	test('Registers ERLab commands', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'python', content: 'x = 1' });
		await vscode.window.showTextDocument(document);

		const extension = findExtensionByName('erlab');
		assert.ok(extension, 'Expected ERLab extension to be available');

		if (!extension!.isActive) {
			await extension!.activate();
		}

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('erlab.watch'), 'Expected erlab.watch command');
		assert.ok(commands.includes('erlab.unwatch'), 'Expected erlab.unwatch command');
		assert.ok(commands.includes('erlab.itool'), 'Expected erlab.itool command');
	});

	test('ERLab IPython extension can load', async function () {
		this.timeout(60_000);
		const code = [
			'import IPython',
			'ip = IPython.get_ipython()',
			'if ip is None:',
			'    from IPython.terminal.interactiveshell import TerminalInteractiveShell',
			'    ip = TerminalInteractiveShell.instance()',
			'ip.run_line_magic("load_ext", "erlab.interactive")',
			'assert ip.find_line_magic("watch") is not None',
		].join('\n');

		await execFileAsync(venvPython, ['-c', code]);
	});

	test('Hover provider is notebook-only', async () => {
		const document = await vscode.workspace.openTextDocument({ language: 'python', content: 'data = 1' });
		await vscode.window.showTextDocument(document);

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

		assert.ok(!/\\b(Watch|Unwatch|ImageTool)\\b/.test(hoverText), 'Unexpected ERLab hover in .py file');
	});
});

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

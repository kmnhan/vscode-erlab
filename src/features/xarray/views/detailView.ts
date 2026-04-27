/**
 * xarray detail webview provider for showing xarray object HTML representation.
 */
import * as vscode from 'vscode';
import {
	buildConfiguredKernelExecutionOptions,
	executeInKernelForOutput,
	extractLastJsonLine,
} from '../../../kernel';
import { buildXarrayHtmlCode, XarrayDisplayOptions } from '../pythonSnippets';
import { logger } from '../../../logger';
import type { XarrayObjectType } from '../types';
import { delay } from '../../../timers';

/**
 * Build a full HTML document for the webview.
 */
function buildXarrayHtml(content: string, cspSource?: string): string {
	const csp = cspSource
		? `default-src 'none'; style-src ${cspSource} 'unsafe-inline';`
		: "default-src 'none'; style-src 'unsafe-inline';";
	return [
		'<!DOCTYPE html>',
		'<html lang="en">',
		'<head>',
		'  <meta charset="utf-8">',
		'  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
		`  <meta http-equiv="Content-Security-Policy" content="${csp}">`,
		'  <title>xarray Object</title>',
		'</head>',
		'<body>',
		content,
		'</body>',
		'</html>',
	].join('\n');
}

/**
 * Build an HTML message (escaped).
 */
function buildXarrayMessage(message: string): string {
	const escaped = message
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<pre>${escaped}</pre>`;
}

export class XarrayDetailViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private readonly executingNotebookKeys = new Set<string>();
	private pendingDetail: { notebookUri: vscode.Uri; variableName: string; type?: XarrayObjectType } | undefined;
	private currentDetail: { notebookUri: vscode.Uri; variableName: string; type?: XarrayObjectType } | undefined;
	private hasContent = false;
	private lastHtml: string | undefined;
	private pendingClear = false;
	private disposed = false;
	private pollAbortVersion = 0;
	private detailRequestVersion = 0;

	private beginDetailRequest(
		notebookUri: vscode.Uri,
		variableName: string,
		type?: XarrayObjectType
	): number {
		this.detailRequestVersion += 1;
		this.currentDetail = { notebookUri, variableName, type };
		return this.detailRequestVersion;
	}

	private isCurrentDetailRequest(version: number): boolean {
		return !this.disposed && version === this.detailRequestVersion;
	}

	private buildDefaultHtml(cspSource?: string): string {
		return buildXarrayHtml(buildXarrayMessage('Select an xarray object to see details.'), cspSource);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		if (this.disposed) {
			return;
		}
		this.view = view;
		// Set HTML with CSP immediately as the first action to avoid security warnings
		const cspSource = view.webview.cspSource;
		if (this.pendingClear) {
			this.pendingClear = false;
			this.lastHtml = this.buildDefaultHtml(cspSource);
			view.webview.html = this.lastHtml;
			this.hasContent = true;
		} else if (this.hasContent && this.lastHtml) {
			// lastHtml already contains CSP, but regenerate with current cspSource just in case
			view.webview.html = this.lastHtml;
		} else {
			view.webview.html = this.buildDefaultHtml(cspSource);
		}
		view.webview.options = { enableScripts: false };
		if (this.pendingDetail) {
			const pending = this.pendingDetail;
			this.pendingDetail = undefined;
			void this.showDetail(pending.notebookUri, pending.variableName, pending.type);
		}
	}

	private isNotebookExecutionInProgress(notebookUri: vscode.Uri | undefined): boolean {
		return notebookUri ? this.executingNotebookKeys.has(notebookUri.toString()) : false;
	}

	setNotebookExecutionInProgress(notebookUri: vscode.Uri, active: boolean): void {
		if (this.disposed) {
			return;
		}
		const notebookKey = notebookUri.toString();
		if (active) {
			this.executingNotebookKeys.add(notebookKey);
			return;
		}
		this.executingNotebookKeys.delete(notebookKey);
		if (
			this.pendingDetail
			&& this.pendingDetail.notebookUri.toString() === notebookKey
		) {
			const pending = this.pendingDetail;
			this.pendingDetail = undefined;
			void this.showDetail(pending.notebookUri, pending.variableName, pending.type);
		}
	}

	isVisibleForNotebook(notebookUri: vscode.Uri): boolean {
		if (this.disposed) {
			return false;
		}
		if (!this.view?.visible || !this.currentDetail) {
			return false;
		}
		return this.currentDetail.notebookUri.toString() === notebookUri.toString();
	}

	refreshCurrentDetail(): void {
		if (this.disposed) {
			return;
		}
		if (!this.currentDetail || !this.view?.visible) {
			return;
		}
		void this.showDetail(
			this.currentDetail.notebookUri,
			this.currentDetail.variableName,
			this.currentDetail.type
		);
	}

	async showDetail(notebookUri: vscode.Uri, variableName: string, type?: XarrayObjectType): Promise<void> {
		if (this.disposed) {
			return;
		}
		logger.info(`Fetching HTML for variable ${variableName}`);
		this.pendingClear = false;
		this.pendingDetail = undefined;
		const requestVersion = this.beginDetailRequest(notebookUri, variableName, type);
		if (!this.view) {
			logger.debug(`Detail view not ready, revealing erlab panel for ${variableName}`);
			await vscode.commands.executeCommand('workbench.view.extension.erlab');
			// Poll for view resolution (50ms intervals, max 2 seconds)
			const maxWaitMs = 2000;
			const intervalMs = 50;
			let waited = 0;
			const pollAbortVersion = this.pollAbortVersion;
			while (!this.view && waited < maxWaitMs && !this.disposed && pollAbortVersion === this.pollAbortVersion) {
				await delay(intervalMs);
				waited += intervalMs;
			}
			if (!this.isCurrentDetailRequest(requestVersion) || pollAbortVersion !== this.pollAbortVersion) {
				return;
			}
			if (!this.view) {
				logger.warn(`Detail view not resolved after ${maxWaitMs}ms, queuing request for ${variableName}`);
				this.pendingDetail = { notebookUri, variableName, type };
				return;
			}
		}
		const view = this.view;
		if (!view || !this.isCurrentDetailRequest(requestVersion)) {
			return;
		}
		if (!view.visible) {
			view.show(false);
		}
		// Show object type in title
		const typeLabel = type ?? 'xarray';
		view.title = `${typeLabel}: ${variableName}`;
		const cspSource = view.webview.cspSource;
		if (this.isNotebookExecutionInProgress(notebookUri)) {
			this.pendingDetail = { notebookUri, variableName, type };
			if (!this.hasContent) {
				view.webview.html = buildXarrayHtml(
					buildXarrayMessage('Waiting for cell execution to finish…'),
					cspSource
				);
				this.hasContent = true;
			}
			return;
		}
		try {
			const config = vscode.workspace.getConfiguration('erlab');
			const displayOptions: XarrayDisplayOptions = {
				displayExpandAttrs: config.get<boolean>('xarray.displayExpandAttrs', true),
				displayExpandCoords: config.get<boolean>('xarray.displayExpandCoords', true),
				displayExpandData: config.get<boolean>('xarray.displayExpandData', false),
			};
			const output = await executeInKernelForOutput(
				notebookUri,
				buildXarrayHtmlCode(variableName, displayOptions),
				buildConfiguredKernelExecutionOptions('xarray-html')
			);
			if (!this.isCurrentDetailRequest(requestVersion) || this.view !== view) {
				return;
			}
			const line = extractLastJsonLine(output);
			if (!line) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage('No HTML representation returned.'), cspSource);
				view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			const parsed = JSON.parse(line) as { html?: string | null; error?: string };
			if (parsed?.error) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage(parsed.error), cspSource);
				view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			if (!parsed?.html) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage('No HTML representation available.'), cspSource);
				view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			this.lastHtml = buildXarrayHtml(parsed.html, cspSource);
			view.webview.html = this.lastHtml;
			this.hasContent = true;
		} catch (error) {
			if (!this.isCurrentDetailRequest(requestVersion) || this.view !== view) {
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.lastHtml = buildXarrayHtml(buildXarrayMessage(message), cspSource);
			view.webview.html = this.lastHtml;
			this.hasContent = true;
		}
	}

	clearDetail(): void {
		if (this.disposed) {
			return;
		}
		this.detailRequestVersion += 1;
		this.pendingDetail = undefined;
		this.currentDetail = undefined;
		this.pendingClear = true;
		const cspSource = this.view?.webview.cspSource;
		this.lastHtml = this.buildDefaultHtml(cspSource);
		this.hasContent = true;
		if (this.view) {
			this.view.title = 'xarray Detail';
			this.view.webview.html = this.lastHtml;
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.pollAbortVersion += 1;
		this.detailRequestVersion += 1;
		this.pendingDetail = undefined;
		this.currentDetail = undefined;
		this.pendingClear = false;
		this.executingNotebookKeys.clear();
		this.view = undefined;
		this.lastHtml = undefined;
		this.hasContent = false;
	}
}

/**
 * xarray detail webview provider for showing xarray object HTML representation.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../../kernel';
import { buildXarrayHtmlCode, XarrayDisplayOptions } from '../pythonSnippets';
import { logger } from '../../../logger';
import type { XarrayObjectType } from '../types';

/**
 * Build a full HTML document for the webview.
 */
export function buildXarrayHtml(content: string, cspSource?: string): string {
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
 * @deprecated Use buildXarrayHtml instead
 */
export const buildDataArrayHtml = buildXarrayHtml;

/**
 * Build an HTML message (escaped).
 */
export function buildXarrayMessage(message: string): string {
	const escaped = message
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<pre>${escaped}</pre>`;
}

/**
 * @deprecated Use buildXarrayMessage instead
 */
export const buildDataArrayMessage = buildXarrayMessage;

export class XarrayDetailViewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private executionInProgress = false;
	private pendingDetail: { notebookUri: vscode.Uri; variableName: string; type?: XarrayObjectType } | undefined;
	private hasContent = false;
	private lastHtml: string | undefined;
	private pendingClear = false;

	private buildDefaultHtml(cspSource?: string): string {
		return buildXarrayHtml(buildXarrayMessage('Select an xarray object to see details.'), cspSource);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
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

	setExecutionInProgress(active: boolean): void {
		this.executionInProgress = active;
		if (!active && this.pendingDetail) {
			const pending = this.pendingDetail;
			this.pendingDetail = undefined;
			void this.showDetail(pending.notebookUri, pending.variableName, pending.type);
		}
	}

	async showDetail(notebookUri: vscode.Uri, variableName: string, type?: XarrayObjectType): Promise<void> {
		logger.info(`Fetching HTML for variable ${variableName}`);
		this.pendingClear = false;
		if (!this.view) {
			logger.debug(`Detail view not ready, revealing erlab panel for ${variableName}`);
			await vscode.commands.executeCommand('workbench.view.extension.erlab');
			// Poll for view resolution (50ms intervals, max 2 seconds)
			const maxWaitMs = 2000;
			const intervalMs = 50;
			let waited = 0;
			while (!this.view && waited < maxWaitMs) {
				await new Promise(resolve => setTimeout(resolve, intervalMs));
				waited += intervalMs;
			}
			if (!this.view) {
				logger.warn(`Detail view not resolved after ${maxWaitMs}ms, queuing request for ${variableName}`);
				this.pendingDetail = { notebookUri, variableName, type };
				return;
			}
		}
		if (!this.view.visible) {
			this.view.show(false);
		}
		// Show object type in title
		const typeLabel = type ?? 'xarray';
		this.view.title = `${typeLabel}: ${variableName}`;
		const cspSource = this.view.webview.cspSource;
		if (this.executionInProgress) {
			this.pendingDetail = { notebookUri, variableName, type };
			if (!this.hasContent) {
				this.view.webview.html = buildXarrayHtml(
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
				{ operation: 'xarray-html' }
			);
			const line = extractLastJsonLine(output);
			if (!line) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage('No HTML representation returned.'), cspSource);
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			const parsed = JSON.parse(line) as { html?: string | null; error?: string };
			if (parsed?.error) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage(parsed.error), cspSource);
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			if (!parsed?.html) {
				this.lastHtml = buildXarrayHtml(buildXarrayMessage('No HTML representation available.'), cspSource);
				this.view.webview.html = this.lastHtml;
				this.hasContent = true;
				return;
			}
			this.lastHtml = buildXarrayHtml(parsed.html, cspSource);
			this.view.webview.html = this.lastHtml;
			this.hasContent = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastHtml = buildXarrayHtml(buildXarrayMessage(message), cspSource);
			this.view.webview.html = this.lastHtml;
			this.hasContent = true;
		}
	}

	clearDetail(): void {
		this.pendingDetail = undefined;
		this.pendingClear = true;
		const cspSource = this.view?.webview.cspSource;
		this.lastHtml = this.buildDefaultHtml(cspSource);
		this.hasContent = true;
		if (this.view) {
			this.view.title = 'xarray Detail';
			this.view.webview.html = this.lastHtml;
		}
	}
}

/**
 * @deprecated Use XarrayDetailViewProvider instead
 */
export const DataArrayDetailViewProvider = XarrayDetailViewProvider;

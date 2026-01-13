/**
 * DataArray detail webview provider for showing DataArray HTML representation.
 */
import * as vscode from 'vscode';
import { executeInKernelForOutput, extractLastJsonLine } from '../../../kernel';
import { buildDataArrayHtmlCode, XarrayDisplayOptions } from '../pythonSnippets';
import { logger } from '../../../logger';

/**
 * Build a full HTML document for the webview.
 */
export function buildDataArrayHtml(content: string): string {
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

/**
 * Build an HTML message (escaped).
 */
export function buildDataArrayMessage(message: string): string {
	const escaped = message
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	return `<pre>${escaped}</pre>`;
}

export class DataArrayDetailViewProvider implements vscode.WebviewViewProvider {
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
		logger.info(`Fetching HTML for variable ${variableName}`);
		if (!this.view) {
			this.pendingDetail = { notebookUri, variableName };
			logger.debug(`Detail view not ready, queuing request for ${variableName}`);
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
			const config = vscode.workspace.getConfiguration('erlab');
			const displayOptions: XarrayDisplayOptions = {
				displayExpandAttrs: config.get<boolean>('dataArray.displayExpandAttrs', true),
				displayExpandCoords: config.get<boolean>('dataArray.displayExpandCoords', true),
				displayExpandData: config.get<boolean>('dataArray.displayExpandData', false),
			};
			const output = await executeInKernelForOutput(notebookUri, buildDataArrayHtmlCode(variableName, displayOptions));
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

/**
 * Types for notebook kernel interaction across providers.
 */
import * as vscode from 'vscode';

export type KernelOutputItem = { mime: string; data: unknown };
export type KernelOutput = { items: KernelOutputItem[]; metadata?: Record<string, unknown> };
export type KernelLike = {
	executeCode: (code: string, token: vscode.CancellationToken) => AsyncIterable<KernelOutput>;
};

export type KernelAccessor = {
	getKernel: (uri: vscode.Uri) => Thenable<KernelLike | undefined>;
};

export type JupyterApi = {
	kernels?: KernelAccessor;
};

export type MarimoApi = {
	experimental?: {
		kernels?: KernelAccessor;
	};
};

export type KernelProvider = 'jupyter' | 'marimo';

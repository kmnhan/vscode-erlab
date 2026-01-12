/**
 * Types for Jupyter kernel interaction.
 */
import * as vscode from 'vscode';

export type KernelOutputItem = { mime: string; data: unknown };
export type KernelOutput = { items: KernelOutputItem[]; metadata?: Record<string, unknown> };
export type KernelLike = {
	executeCode: (code: string, token: vscode.CancellationToken) => AsyncIterable<KernelOutput>;
};
export type JupyterApi = {
	kernels?: {
		getKernel: (uri: vscode.Uri) => Thenable<KernelLike | undefined>;
	};
};

/**
 * Pinned DataArray store for persisting pinned state.
 */
import * as vscode from 'vscode';

const PINNED_DATAARRAYS_KEY = 'erlab.pinnedDataArrays';

export class PinnedDataArrayStore {
	private readonly state: vscode.Memento;

	constructor(state: vscode.Memento) {
		this.state = state;
	}

	isPinned(notebookUri: vscode.Uri, variableName: string): boolean {
		return this.getPinned(notebookUri).includes(variableName);
	}

	getPinned(notebookUri: vscode.Uri): string[] {
		const allPinned = this.state.get<Record<string, string[]>>(PINNED_DATAARRAYS_KEY, {});
		return allPinned[notebookUri.toString()] ?? [];
	}

	async pin(notebookUri: vscode.Uri, variableName: string): Promise<void> {
		const pinned = this.getPinned(notebookUri);
		if (pinned.includes(variableName)) {
			return;
		}
		await this.setPinned(notebookUri, [...pinned, variableName]);
	}

	async unpin(notebookUri: vscode.Uri, variableName: string): Promise<void> {
		const pinned = this.getPinned(notebookUri).filter((name) => name !== variableName);
		await this.setPinned(notebookUri, pinned);
	}

	async setPinned(notebookUri: vscode.Uri, pinned: string[]): Promise<void> {
		const allPinned = this.state.get<Record<string, string[]>>(PINNED_DATAARRAYS_KEY, {});
		const next = { ...allPinned, [notebookUri.toString()]: pinned };
		await this.state.update(PINNED_DATAARRAYS_KEY, next);
	}
}

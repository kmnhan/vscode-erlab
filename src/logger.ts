/**
 * Logger module for the ERLab extension.
 *
 * Uses VS Code's LogOutputChannel for built-in log level filtering via the cogwheel UI.
 */
import * as vscode from 'vscode';

let outputChannel: vscode.LogOutputChannel | undefined;

/**
 * Initialize the logger. Should be called once during extension activation.
 */
export function initializeLogger(context: vscode.ExtensionContext): vscode.LogOutputChannel {
	outputChannel = vscode.window.createOutputChannel('ERLab', { log: true });
	context.subscriptions.push(outputChannel);
	return outputChannel;
}

/**
 * Get the logger instance.
 */
export function getLogger(): vscode.LogOutputChannel | undefined {
	return outputChannel;
}

/**
 * Logger facade with convenience methods.
 * Uses structured args format: logger.info("Found {0} items", count)
 */
export const logger = {
	/**
	 * Log a trace message (most verbose, hidden by default).
	 */
	trace(message: string, ...args: unknown[]): void {
		outputChannel?.trace(message, ...args);
	},

	/**
	 * Log a debug message.
	 */
	debug(message: string, ...args: unknown[]): void {
		outputChannel?.debug(message, ...args);
	},

	/**
	 * Log an info message.
	 */
	info(message: string, ...args: unknown[]): void {
		outputChannel?.info(message, ...args);
	},

	/**
	 * Log a warning message.
	 */
	warn(message: string, ...args: unknown[]): void {
		outputChannel?.warn(message, ...args);
	},

	/**
	 * Log an error message.
	 */
	error(message: string | Error, ...args: unknown[]): void {
		outputChannel?.error(message, ...args);
	},

	/**
	 * Show the output channel in the UI.
	 */
	show(): void {
		outputChannel?.show();
	},
};

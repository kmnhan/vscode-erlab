/**
 * Track in-flight kernel executions so extension shutdown can cancel local waits.
 */

type ActiveExecution = {
	cancel: () => void;
};

type ActiveExecutionRegistration = {
	dispose: () => void;
};

const activeExecutions = new Set<ActiveExecution>();

export function registerActiveKernelExecution(cancel: () => void): ActiveExecutionRegistration {
	const execution: ActiveExecution = { cancel };
	let disposed = false;
	activeExecutions.add(execution);
	return {
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			activeExecutions.delete(execution);
		},
	};
}

export function shutdownActiveKernelExecutions(): void {
	const executions = Array.from(activeExecutions);
	activeExecutions.clear();
	for (const execution of executions) {
		try {
			execution.cancel();
		} catch {
			// Ignore cancellation failures during shutdown.
		}
	}
}

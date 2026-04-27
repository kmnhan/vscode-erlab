/**
 * Timer helpers that should not keep the extension host alive during shutdown.
 */

export type TimeoutHandle = ReturnType<typeof setTimeout>;

export function setNonBlockingTimeout<TArgs extends unknown[]>(
	callback: (...args: TArgs) => void,
	delay: number = 0,
	...args: TArgs
): TimeoutHandle {
	const handle = setTimeout(() => callback(...args), delay);
	handle.unref?.();
	return handle;
}

export function delay(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		setNonBlockingTimeout(resolve, delayMs);
	});
}

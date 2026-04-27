/**
 * Unit tests for non-blocking timer helpers.
 */
import * as assert from 'assert';
import { setNonBlockingTimeout } from '../../timers';

suite('timer helpers', () => {
	const originalSetTimeout = global.setTimeout;

	teardown(() => {
		global.setTimeout = originalSetTimeout;
	});

	test('calls unref when available', () => {
		let observedDelay: number | undefined;
		let capturedCallback: (() => void) | undefined;
		let unrefCalled = false;
		const handle = {
			unref: () => {
				unrefCalled = true;
			},
		} as unknown as ReturnType<typeof setTimeout>;

		global.setTimeout = ((callback: () => void, delay?: number) => {
			observedDelay = delay;
			capturedCallback = callback;
			return handle;
		}) as typeof setTimeout;

		const returned = setNonBlockingTimeout(() => { }, 123);
		global.setTimeout = originalSetTimeout;
		capturedCallback?.();

		assert.strictEqual(returned, handle);
		assert.strictEqual(observedDelay, 123);
		assert.strictEqual(unrefCalled, true);
	});

	test('works when unref is unavailable', () => {
		let invoked = false;
		let capturedCallback: (() => void) | undefined;
		const handle = {} as ReturnType<typeof setTimeout>;

		global.setTimeout = ((callback: () => void) => {
			capturedCallback = callback;
			return handle;
		}) as typeof setTimeout;

		const returned = setNonBlockingTimeout(() => {
			invoked = true;
		}, 25);
		global.setTimeout = originalSetTimeout;
		capturedCallback?.();

		assert.strictEqual(invoked, true);
		assert.strictEqual(returned, handle);
	});
});

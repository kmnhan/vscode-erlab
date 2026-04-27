/**
 * Unit tests for active kernel execution tracking.
 */
import * as assert from 'assert';
import { registerActiveKernelExecution, shutdownActiveKernelExecutions } from '../../kernel/executionTracker';

suite('kernel execution tracker', () => {
	teardown(() => {
		shutdownActiveKernelExecutions();
	});

	test('cancels active executions during shutdown', () => {
		let canceled = 0;
		registerActiveKernelExecution(() => {
			canceled += 1;
		});
		registerActiveKernelExecution(() => {
			canceled += 1;
		});

		shutdownActiveKernelExecutions();

		assert.strictEqual(canceled, 2);
	});

	test('shutdown is idempotent', () => {
		let canceled = 0;
		registerActiveKernelExecution(() => {
			canceled += 1;
		});

		shutdownActiveKernelExecutions();
		shutdownActiveKernelExecutions();

		assert.strictEqual(canceled, 1);
	});

	test('disposed registrations are skipped during shutdown', () => {
		let canceled = 0;
		const registration = registerActiveKernelExecution(() => {
			canceled += 1;
		});
		registration.dispose();

		shutdownActiveKernelExecutions();

		assert.strictEqual(canceled, 0);
	});
});

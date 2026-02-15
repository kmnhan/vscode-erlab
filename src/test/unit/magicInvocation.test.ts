/**
 * Unit tests for magic invocation code builders.
 */
import * as assert from 'assert';
import {
	buildMagicInvocation,
	buildItoolInvocation,
	buildMarimoItoolInvocation,
	buildMarimoToolInvocation,
	buildMarimoWatchInvocation,
} from '../../commands/magicInvocation';

suite('Magic Invocation', () => {
	suite('buildMagicInvocation', () => {
		test('generates valid Python code', () => {
			const code = buildMagicInvocation('watch', 'myvar');
			assert.ok(code.includes('import importlib.util'));
			assert.ok(code.includes('import IPython'));
			assert.ok(code.includes('erlab.interactive'));
			assert.ok(code.includes('run_line_magic'));
			assert.ok(code.includes('"watch"'));
		});

		test('includes variable name in args', () => {
			const code = buildMagicInvocation('watch', 'test_array');
			assert.ok(code.includes('"test_array"'));
		});

		test('generates code that checks for erlab package', () => {
			const code = buildMagicInvocation('itool', 'data');
			assert.ok(code.includes('find_spec("erlab")'));
		});

		test('cleans up temporary variables', () => {
			const code = buildMagicInvocation('watch', 'x');
			assert.ok(code.includes('del __erlab_tmp__ip'));
			assert.ok(code.includes('del __erlab_tmp__args'));
		});
	});

	suite('buildItoolInvocation', () => {
		test('generates basic itool code without manager', () => {
			const code = buildItoolInvocation('mydata', false);
			assert.ok(code.includes('"itool"'));
			assert.ok(code.includes('"mydata"'));
			// Should not import the manager module (but 'manager' appears in extension_manager)
			assert.ok(!code.includes('erlab.interactive.imagetool.manager'));
		});

		test('generates itool code with manager check', () => {
			const code = buildItoolInvocation('mydata', true);
			assert.ok(code.includes('erlab.interactive.imagetool.manager'));
			assert.ok(code.includes('is_running()'));
			assert.ok(code.includes('-m mydata'));
		});

		test('includes cleanup for manager import', () => {
			const code = buildItoolInvocation('data', true);
			assert.ok(code.includes('del __erlab_tmp__manager'));
		});
	});

	suite('buildMarimoToolInvocation', () => {
		test('generates direct invocation code with data_name', () => {
			const code = buildMarimoToolInvocation('ktool', 'mydata');
			assert.ok(code.includes('getattr(__erlab_tmp__interactive, "ktool")'));
			assert.ok(code.includes('data_name=__erlab_tmp__varname'));
			assert.ok(code.includes('__erlab_tmp__varname = "mydata"'));
		});
	});

	suite('buildMarimoItoolInvocation', () => {
		test('generates direct itool code with manager flag', () => {
			const code = buildMarimoItoolInvocation('mydata', true);
			assert.ok(code.includes('__erlab_tmp__interactive.itool('));
			assert.ok(code.includes('manager=True'));
		});
	});

	suite('buildMarimoWatchInvocation', () => {
		test('generates watch code using manager.watch API', () => {
			const code = buildMarimoWatchInvocation('mydata', { unwatch: false });
			assert.ok(code.includes('erlab.interactive.imagetool.manager'));
			assert.ok(code.includes('if not callable(getattr(__erlab_tmp__manager, "watch", None)):'));
			assert.ok(code.includes('watch/unwatch requires erlab 3.20.0 or later. Please upgrade erlab.'));
			assert.ok(code.includes('manager.watch(__erlab_tmp__varname)'));
			assert.ok(!code.includes('watch_data('));
		});

		test('generates unwatch code', () => {
			const code = buildMarimoWatchInvocation('mydata', { unwatch: true });
			assert.ok(code.includes('manager.watch(__erlab_tmp__varname, stop=True, remove=False)'));
			assert.ok(!code.includes('unwatch_data('));
		});
	});
});

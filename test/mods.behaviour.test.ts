// mods.behaviour.test.ts — drives each mod through its real factory with a fake ModApi.
// exports: none (node:test)
// used_by: npm test
// related: test/harness.ts, mods/caveman.ts, mods/ponytail.ts, mods/rtk.ts, mods/compress.ts
// rules: setups run each mod through its exported default factory, so the wiring and the hooks are covered, not only the pure helpers.
// agent: 2026-11-02 initial

import {test} from 'node:test';
import assert from 'node:assert/strict';
import caveman, {normalizeCavemanLevel} from '../mods/caveman.ts';
import ponytail from '../mods/ponytail.ts';
import rtk from '../mods/rtk.ts';
import compress from '../mods/compress.ts';
import {createFakeCmd, runHandler, messageOf} from './harness.ts';

type Fake = ReturnType<typeof createFakeCmd>;

function load(factory: (cmd: never) => void, options: Parameters<typeof createFakeCmd>[0] = {}) {
	const fake = createFakeCmd(options);
	fake.cmd.name = 'probe';
	factory(fake.cmd as never);
	return fake;
}

function sessionStart(fake: Fake) {
	for (const hook of fake.hooks) hook.onSessionStart?.();
}

function appends(fake: Fake) {
	return fake.hooks.map(hook => hook.appendSystemPrompt?.()).filter(Boolean).join('\n');
}

test('caveman: off by default, so nothing reaches the prompt', () => {
	const fake = load(caveman);
	assert.equal(appends(fake), '');
});

test('caveman: /caveman full turns it on and injects one block', () => {
	const fake = load(caveman);
	assert.match(messageOf(runHandler(fake.commands, 'caveman', 'full')), /Caveman full on/);
	const prompt = appends(fake);
	assert.match(prompt, /^<caveman>/);
	assert.match(prompt, /Caveman full active/);
	assert.equal((prompt.match(/<caveman>/g) ?? []).length, 1);
});

test('caveman: a level switch replaces the block instead of stacking', () => {
	const fake = load(caveman);
	runHandler(fake.commands, 'caveman', 'lite');
	runHandler(fake.commands, 'caveman', 'megacave-ultra');
	const prompt = appends(fake);
	assert.match(prompt, /Caveman megacave-ultra active/);
	assert.doesNotMatch(prompt, /Caveman lite active/);
});

test('caveman: the stop phrase turns it off and consumes the message', () => {
	const fake = load(caveman);
	runHandler(fake.commands, 'caveman', 'full');
	const result = fake.hooks[0].transformInput?.({text: 'stop caveman'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(appends(fake), '');
});

test('caveman: an ordinary sentence mentioning the mode does not turn it off', () => {
	const fake = load(caveman);
	runHandler(fake.commands, 'caveman', 'full');
	assert.equal(fake.hooks[0].transformInput?.({text: 'add a normal mode toggle'}), undefined);
});

test('caveman: status reports the live mode and unknown levels print usage', () => {
	const fake = load(caveman);
	runHandler(fake.commands, 'caveman', 'ultra');
	assert.equal(messageOf(runHandler(fake.commands, 'caveman', 'status')), 'Caveman mode: ultra');
	assert.match(messageOf(runHandler(fake.commands, 'caveman', 'nope')), /Unknown caveman level/);
});

test('caveman: a per-session flag applies at session start, not at factory time', () => {
	const fake = load(caveman, {flags: {caveman: 'lite'}});
	assert.equal(appends(fake), '');
	sessionStart(fake);
	assert.match(appends(fake), /Caveman lite active/);
});

test('caveman: normalizeCavemanLevel maps aliases and rejects review', () => {
	assert.equal(normalizeCavemanLevel('wenyan'), null);
	assert.equal(normalizeCavemanLevel('MEGACAVE-FULL'), 'megacave-full');
});

test('ponytail: /ponytail ultra injects the ultra block with its marker', () => {
	const fake = load(ponytail);
	runHandler(fake.commands, 'ponytail', 'ultra');
	const prompt = appends(fake);
	assert.match(prompt, /PONYTAIL MODE ACTIVE — level: ultra/);
	assert.match(prompt, /questions the request/);
});

test('ponytail: "stop ponytail" turns it off', () => {
	const fake = load(ponytail);
	runHandler(fake.commands, 'ponytail', 'full');
	fake.hooks[0].transformInput?.({text: 'stop ponytail'});
	assert.equal(appends(fake), '');
});

test('rtk: off means no rewrite and no guidance', async () => {
	let calls = 0;
	const fake = load(rtk, {
		exec: async () => {
			calls += 1;
			return {stdout: 'rtk git status', stderr: '', code: 0};
		},
	});
	const result = await fake.hooks[0].beforeToolCall?.({toolName: 'shell_command', input: {command: 'git status'}});
	assert.equal(result, undefined);
	assert.equal(calls, 0);
	assert.equal(appends(fake), '');
});

test('rtk: on rewrites a shell command through rtk and injects guidance', async () => {
	const seen: string[] = [];
	const fake = load(rtk, {
		exec: async request => {
			seen.push(`${request.command} ${(request.args ?? []).join(' ')}`.trim());
			return {stdout: 'rtk git status', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	const result = (await fake.hooks[0].beforeToolCall?.({
		toolName: 'shell_command',
		input: {command: 'git status'},
	})) as {input: {command: string}};
	assert.equal(result.input.command, 'rtk git status');
	assert.match(seen[0], /rewrite git status$/);
	assert.match(appends(fake), /<rtk>/);
});

test('rtk: a command with no rewrite is left untouched', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: '', stderr: '', code: 1})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = await fake.hooks[0].beforeToolCall?.({toolName: 'shell_command', input: {command: 'echo hi'}});
	assert.equal(result, undefined);
});

test('rtk: an unrelated tool is never rewritten', async () => {
	let calls = 0;
	const fake = load(rtk, {
		exec: async () => {
			calls += 1;
			return {stdout: 'rtk read x', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(await fake.hooks[0].beforeToolCall?.({toolName: 'read_file', input: {file_path: 'x'}}), undefined);
	assert.equal(calls, 0);
});

test('rtk: a large grep result is condensed, a small one is left alone', async () => {
	const big = 'x'.repeat(4000);
	const fake = load(rtk, {
		exec: async () => ({stdout: 'src/a.ts:1: hit\n', stderr: '', code: 0}),
	});
	runHandler(fake.commands, 'rtk', 'on');
	const filtered = (await fake.hooks[0].afterToolCall?.({
		toolName: 'grep',
		result: [{type: 'text', text: big}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0].text, 'src/a.ts:1: hit\n');

	const small = await fake.hooks[0].afterToolCall?.({
		toolName: 'grep',
		result: [{type: 'text', text: 'tiny'}],
		isError: false,
	});
	assert.equal(small, undefined);
});

test('rtk: a failed tool result is never filtered', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'condensed', stderr: '', code: 0})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = await fake.hooks[0].afterToolCall?.({
		toolName: 'grep',
		result: [{type: 'text', text: 'x'.repeat(4000)}],
		isError: true,
	});
	assert.equal(result, undefined);
});

// Rules: a grep hit can contain any bytes, so the filter must never splice tool text into a shell command line.
test('rtk: hostile grep output reaches the filter as data, not as shell source', async () => {
	const commands: string[] = [];
	const fake = load(rtk, {
		exec: async request => {
			commands.push([request.command, ...(request.args ?? [])].join(' '));
			return {stdout: 'ok\n', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	const payload = `${'$(touch /tmp/pwned)'.repeat(200)}\nRTK_EOF\n; rm -rf /\n`;
	assert.ok(payload.length > 1200, 'the payload must exceed the filter threshold');
	await fake.hooks[0].afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: payload}], isError: false});

	const filterCommand = commands.find(command => command.includes(' pipe '));
	assert.ok(filterCommand, 'the filter ran');
	assert.ok(!filterCommand.includes('/tmp/pwned'), 'payload is not in the command line');
	assert.ok(!filterCommand.includes('rm -rf'), 'payload is not in the command line');
	assert.match(filterCommand, / pipe -f grep < "/, 'the payload arrives through a redirected file');
});

// Rules: rtk's exit 2 is a deny in its own contract — running the command anyway would ignore a rule the operator wrote.
test('rtk: exit 2 with a message blocks the call and carries the reason', async () => {
	const fake = load(rtk, {
		exec: async () => ({stdout: 'pipeline rule forbids push', stderr: '', code: 2}),
	});
	runHandler(fake.commands, 'rtk', 'on');
	const result = (await fake.hooks[0].beforeToolCall?.({
		toolCallId: 'c1',
		toolName: 'shell_command',
		input: {command: 'git push origin main'},
	})) as {block: boolean; additionalContext: string};
	assert.equal(result.block, true);
	assert.match(result.additionalContext, /pipeline rule forbids push/);
});

// Rules: an empty exit 2 is a host deny rule rtk only relays; the host owns that decision, so the command passes.
test('rtk: exit 2 without a message passes, because the deny belongs to the host', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: '', stderr: '', code: 2})});
	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(
		await fake.hooks[0].beforeToolCall?.({toolCallId: 'c1', toolName: 'shell_command', input: {command: 'git push'}}),
		undefined,
	);
});

test('rtk: exit 3 still supplies a rewrite', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'rtk ls', stderr: '', code: 3})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = (await fake.hooks[0].beforeToolCall?.({
		toolCallId: 'c1',
		toolName: 'shell_command',
		input: {command: 'ls'},
	})) as {input: {command: string}};
	assert.equal(result.input.command, 'rtk ls');
});

// Rules: `npm test` has no rewrite, so the only way its output is ever condensed is the auto-detect pass.
test('rtk: unrewritten shell output is still condensed by auto-detect', async () => {
	const calls: string[] = [];
	const fake = load(rtk, {
		exec: async request => {
			calls.push([request.command, ...(request.args ?? [])].join(' '));
			if (request.args?.[0] === 'rewrite') return {stdout: '', stderr: '', code: 1};
			return {stdout: 'FAILURES (1):\n', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(
		await fake.hooks[0].beforeToolCall?.({toolCallId: 'c9', toolName: 'shell_command', input: {command: 'npm test'}}),
		undefined,
	);
	const filtered = (await fake.hooks[0].afterToolCall?.({
		toolCallId: 'c9',
		toolName: 'shell_command',
		result: [{type: 'text', text: 'x'.repeat(3000)}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0].text, 'FAILURES (1):\n');
	assert.match(calls.at(-1) ?? '', / pipe < "/, 'auto-detect runs with no -f');
});

// Rules: a rewritten call was already filtered by rtk itself, so a second pass would cost a process and gain nothing.
test('rtk: a shell call rtk rewrote is not filtered twice', async () => {
	let pipes = 0;
	const fake = load(rtk, {
		exec: async request => {
			if (request.args?.[0] === 'rewrite') return {stdout: 'rtk git status', stderr: '', code: 0};
			if (request.args?.join(' ').includes(' pipe ')) pipes += 1;
			return {stdout: 'condensed\n', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	await fake.hooks[0].beforeToolCall?.({toolCallId: 'c2', toolName: 'shell_command', input: {command: 'git status'}});
	await fake.hooks[0].afterToolCall?.({
		toolCallId: 'c2',
		toolName: 'shell_command',
		result: [{type: 'text', text: 'x'.repeat(3000)}],
		isError: false,
	});
	assert.equal(pipes, 0);
});

test('rtk: a stray result without a matching rewrite is filtered', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'condensed\n', stderr: '', code: 0})});
	runHandler(fake.commands, 'rtk', 'on');
	const filtered = (await fake.hooks[0].afterToolCall?.({
		toolCallId: 'never-seen',
		toolName: 'shell_command',
		result: [{type: 'text', text: 'x'.repeat(3000)}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0].text, 'condensed\n');
});

test('rtk: the shell filter has its own off switch', async () => {
	const fake = load(rtk, {
		flags: {'rtk-shell': false},
		exec: async () => ({stdout: 'condensed\n', stderr: '', code: 0}),
	});
	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(
		await fake.hooks[0].afterToolCall?.({
			toolCallId: 'c3',
			toolName: 'shell_command',
			result: [{type: 'text', text: 'x'.repeat(3000)}],
			isError: false,
		}),
		undefined,
	);
});

// Rules: `cmd.exec` has no timeout option, so a hung rtk must be aborted or it blocks the tool call forever.
test('rtk: every rtk call is bounded by an abort signal', async () => {
	const signals: Array<AbortSignal | undefined> = [];
	const fake = load(rtk, {
		exec: async request => {
			signals.push(request.signal);
			return {stdout: 'rtk git status', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	await fake.hooks[0].beforeToolCall?.({toolCallId: 'c4', toolName: 'shell_command', input: {command: 'git status'}});
	assert.ok(signals.length > 0);
	assert.ok(signals.every(signal => signal instanceof AbortSignal), 'the call carries an AbortSignal');
});

test('rtk: a too-old binary turns rewrites off and says so', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'rtk 0.22.9', stderr: '', code: 0})});
	fake.hooks[0].onSessionStart?.();
	await new Promise(resolve => setTimeout(resolve, 0));
	const result = await fake.hooks[0].beforeToolCall?.({
		toolCallId: 'c5',
		toolName: 'shell_command',
		input: {command: 'git status'},
	});
	assert.equal(result, undefined, 'no rewrite from a binary below the supported minor');
	assert.match(messageOf(await runHandler(fake.commands, 'rtk', 'status')), /too old/);
	assert.equal(appends(fake), '', 'no guidance promising rewrites that cannot happen');
});

test('rtk: /rtk gain reports the stored savings, and says so when it cannot read them', async () => {
	const fake = load(rtk, {
		exec: async () => ({
			stdout: JSON.stringify({summary: {total_commands: 120, total_saved: 5400, total_input: 9000, avg_savings_pct: 60}}),
			stderr: '',
			code: 0,
		}),
	});
	assert.match(messageOf(await runHandler(fake.commands, 'rtk', 'gain')), /5,400 tokens over 120 commands \(60\.0%\)/);

	const broken = load(rtk, {exec: async () => ({stdout: 'not json', stderr: '', code: 0})});
	assert.match(messageOf(await runHandler(broken.commands, 'rtk', 'gain')), /Could not read rtk gain/);
});

test('compress: the preset reaches all three mods and status reads them back', () => {
	const cavemanFake = load(caveman);
	const ponytailFake = load(ponytail);
	const rtkFake = load(rtk);
	const compressFake = load(compress);

	// the fake keeps one exposed registry per cmd; wire the siblings' names onto it
	compressFake.cmd.use = (mod: string, name: string) => {
		const source = mod === 'caveman' ? cavemanFake : mod === 'ponytail' ? ponytailFake : rtkFake;
		return source.exposed.get('probe')?.get(name);
	};

	const applied = messageOf(runHandler(compressFake.commands, 'compress', 'max'));
	assert.match(applied, /caveman=ultra \| ponytail=ultra \| rtk=on/);
	assert.match(messageOf(runHandler(compressFake.commands, 'compress', 'status')), /caveman=ultra/);
	assert.match(appends(cavemanFake), /Caveman ultra active/);
	assert.match(appends(ponytailFake), /level: ultra/);
	assert.match(appends(rtkFake), /<rtk>/);

	runHandler(compressFake.commands, 'compress', 'off');
	assert.equal(appends(cavemanFake), '');
	assert.equal(appends(ponytailFake), '');
	assert.equal(appends(rtkFake), '');
});

test('compress: an unknown preset prints usage and changes nothing', () => {
	const fake = load(compress);
	assert.match(messageOf(runHandler(fake.commands, 'compress', 'turbo')), /Unknown preset: turbo/);
});

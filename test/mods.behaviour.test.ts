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
import {createFakeCmd, firstHook, runHandler, messageOf} from './harness.ts';

type Fake = ReturnType<typeof createFakeCmd>;

// Rules: the mod resolves its binary with resolveBin, which probes PATH and ~/.bun/bin. With no rtk installed every hook is a no-op, so the suite would pass on a machine that has rtk and fail in CI — measured: 14 failures under an empty HOME. Seeding rtk-bin pins the factory to a fixed path, so the fake exec is the only thing consulted and the suite is hermetic anywhere.
const TEST_BIN = '/opt/rtk/bin/rtk';

function load(factory: (cmd: never) => void, options: Parameters<typeof createFakeCmd>[0] = {}) {
	const fake = createFakeCmd({...options, flags: {'rtk-bin': TEST_BIN, ...options.flags}});
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
	const result = firstHook(fake).transformInput?.({text: 'stop caveman'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(appends(fake), '');
});

test('caveman: an ordinary sentence mentioning the mode does not turn it off', () => {
	const fake = load(caveman);
	runHandler(fake.commands, 'caveman', 'full');
	assert.equal(firstHook(fake).transformInput?.({text: 'add a normal mode toggle'}), undefined);
});

// Rules: the host stops the transformInput chain at the first `handled`, so `normal mode` must turn the siblings off itself or they keep running.
test('caveman: "normal mode" turns off every reachable sibling, not just caveman', () => {
	const cavemanFake = load(caveman);
	const ponytailFake = load(ponytail);
	const rtkFake = load(rtk);
	cavemanFake.cmd.use = (mod: string, name: string) => {
		const source = mod === 'ponytail' ? ponytailFake : mod === 'rtk' ? rtkFake : cavemanFake;
		return source.exposed.get('probe')?.get(name);
	};

	runHandler(cavemanFake.commands, 'caveman', 'full');
	runHandler(ponytailFake.commands, 'ponytail', 'ultra');
	runHandler(rtkFake.commands, 'rtk', 'on');
	assert.notEqual(appends(cavemanFake), '');
	assert.notEqual(appends(ponytailFake), '');

	const result = firstHook(cavemanFake).transformInput?.({text: 'normal mode'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(appends(cavemanFake), '', 'caveman is off');
	assert.equal(appends(ponytailFake), '', 'ponytail followed through its exposed setMode');
	assert.equal(appends(rtkFake), '', 'rtk followed too');
});

// Rules: the phrase must work when caveman and ponytail are already off, so a lone `rtk` cannot outlive it.
test('caveman: "normal mode" turns off a sibling that is the only mode running', () => {
	const cavemanFake = load(caveman);
	const rtkFake = load(rtk);
	cavemanFake.cmd.use = (mod: string, name: string) => (mod === 'rtk' ? rtkFake.exposed.get('probe')?.get(name) : undefined);

	runHandler(rtkFake.commands, 'rtk', 'on');
	assert.notEqual(appends(rtkFake), '');

	const result = firstHook(cavemanFake).transformInput?.({text: 'normal mode'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(appends(rtkFake), '', 'rtk is off even though caveman itself was already off');
});

// Rules: ponytail is usually loaded and already off, and the host stops the chain at the first `handled` — so a ponytail that gated on its own mode would swallow the phrase and leave rtk running.
test('ponytail: "normal mode" still reaches a sibling while ponytail is off', () => {
	const ponytailFake = load(ponytail);
	const rtkFake = load(rtk);
	ponytailFake.cmd.use = (mod: string, name: string) => (mod === 'rtk' ? rtkFake.exposed.get('probe')?.get(name) : undefined);
	const rtkMode = () => rtkFake.exposed.get('probe')?.get('getMode') as (() => string) | undefined;

	runHandler(rtkFake.commands, 'rtk', 'on');
	assert.equal(rtkMode()?.(), 'on');

	const result = firstHook(ponytailFake).transformInput?.({text: 'normal mode'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(rtkMode()?.(), 'off', 'the sibling was turned off even though ponytail itself was already off');
});

// Rules: a session may load rtk alone; the phrase has to resolve there too, so rtk answers it rather than passing it to the model.
test('rtk: "normal mode" turns rtk off when it is the only mod loaded', () => {
	const fake = load(rtk);
	const mode = () => fake.exposed.get('probe')?.get('getMode') as (() => string) | undefined;

	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(mode()?.(), 'on');

	const result = firstHook(fake).transformInput?.({text: 'normal mode'}) as {action: string};
	assert.equal(result.action, 'handled');
	assert.equal(mode()?.(), 'off');
	assert.equal(firstHook(fake).appendSystemPrompt?.(), undefined, 'and the guidance block is gone');
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
	firstHook(fake).transformInput?.({text: 'stop ponytail'});
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
	const result = await firstHook(fake).beforeToolCall?.({toolName: 'shell_command', input: {command: 'git status'}});
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
	const result = (await firstHook(fake).beforeToolCall?.({
		toolName: 'shell_command',
		input: {command: 'git status'},
	})) as {input: {command: string}};
	assert.match(result.input.command, /rtk'? git status$/, 'the rewrite is pinned to the resolved absolute path');
	assert.match(seen[0] ?? '', /rewrite git status$/);
	assert.match(appends(fake), /<rtk>/);
});

// Rules: shell_command carries an optional `args` array beside `command`; the rewrite must replace only the command and leave those args for the tool to append, or a rewritten call would drop them.
test('rtk: a rewrite keeps the call\'s own args intact', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'rtk git status', stderr: '', code: 0})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = (await firstHook(fake).beforeToolCall?.({
		toolName: 'shell_command',
		input: {command: 'git status', args: ['--porcelain'], timeout: 5000},
	})) as {input: {command: string; args: string[]; timeout: number}};
	assert.match(result.input.command, /rtk'? git status$/, 'only the command is rewritten');
	assert.deepEqual(result.input.args, ['--porcelain'], 'the args survive');
	assert.equal(result.input.timeout, 5000, 'and every other input field survives');
});

test('rtk: a command with no rewrite is left untouched', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: '', stderr: '', code: 1})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = await firstHook(fake).beforeToolCall?.({toolName: 'shell_command', input: {command: 'echo hi'}});
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
	assert.equal(await firstHook(fake).beforeToolCall?.({toolName: 'read_file', input: {file_path: 'x'}}), undefined);
	assert.equal(calls, 0);
});

test('rtk: a large grep result is condensed, a small one is left alone', async () => {
	const big = 'x'.repeat(4000);
	const fake = load(rtk, {
		exec: async () => ({stdout: 'src/a.ts:1: hit\n', stderr: '', code: 0}),
	});
	runHandler(fake.commands, 'rtk', 'on');
	const filtered = (await firstHook(fake).afterToolCall?.({
		toolName: 'grep',
		result: [{type: 'text', text: big}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0]?.text, 'src/a.ts:1: hit\n');

	const small = await firstHook(fake).afterToolCall?.({
		toolName: 'grep',
		result: [{type: 'text', text: 'tiny'}],
		isError: false,
	});
	assert.equal(small, undefined);
});

test('rtk: a failed tool result is never filtered', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'condensed', stderr: '', code: 0})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = await firstHook(fake).afterToolCall?.({
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
	await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: payload}], isError: false});

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
	const result = (await firstHook(fake).beforeToolCall?.({
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
		await firstHook(fake).beforeToolCall?.({toolCallId: 'c1', toolName: 'shell_command', input: {command: 'git push'}}),
		undefined,
	);
});

test('rtk: exit 3 still supplies a rewrite', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'rtk ls', stderr: '', code: 3})});
	runHandler(fake.commands, 'rtk', 'on');
	const result = (await firstHook(fake).beforeToolCall?.({
		toolCallId: 'c1',
		toolName: 'shell_command',
		input: {command: 'ls'},
	})) as {input: {command: string}};
	assert.match(result.input.command, /rtk'? ls$/, 'the rewrite is pinned to the resolved absolute path');
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
		await firstHook(fake).beforeToolCall?.({toolCallId: 'c9', toolName: 'shell_command', input: {command: 'npm test'}}),
		undefined,
	);
	const filtered = (await firstHook(fake).afterToolCall?.({
		toolCallId: 'c9',
		toolName: 'shell_command',
		result: [{type: 'text', text: 'x'.repeat(3000)}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0]?.text, 'FAILURES (1):\n');
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
	await firstHook(fake).beforeToolCall?.({toolCallId: 'c2', toolName: 'shell_command', input: {command: 'git status'}});
	await firstHook(fake).afterToolCall?.({
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
	const filtered = (await firstHook(fake).afterToolCall?.({
		toolCallId: 'never-seen',
		toolName: 'shell_command',
		result: [{type: 'text', text: 'x'.repeat(3000)}],
		isError: false,
	})) as {content: Array<{text: string}>};
	assert.equal(filtered.content[0]?.text, 'condensed\n');
});

test('rtk: the shell filter has its own off switch', async () => {
	const fake = load(rtk, {
		flags: {'rtk-shell': false},
		exec: async () => ({stdout: 'condensed\n', stderr: '', code: 0}),
	});
	runHandler(fake.commands, 'rtk', 'on');
	assert.equal(
		await firstHook(fake).afterToolCall?.({
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
	await firstHook(fake).beforeToolCall?.({toolCallId: 'c4', toolName: 'shell_command', input: {command: 'git status'}});
	assert.ok(signals.length > 0);
	assert.ok(signals.every(signal => signal instanceof AbortSignal), 'the call carries an AbortSignal');
});

test('rtk: a too-old binary turns rewrites off and says so', async () => {
	const fake = load(rtk, {exec: async () => ({stdout: 'rtk 0.22.9', stderr: '', code: 0})});
	firstHook(fake).onSessionStart?.();
	await new Promise(resolve => setTimeout(resolve, 0));
	const result = await firstHook(fake).beforeToolCall?.({
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

// Rules: a shell call rtk already rewrote had its output filtered by rtk, so condensing again spends a second process for nothing — the rewritten-call marker must suppress the shell pass for that exact toolCallId, and only for it.
test('rtk: a rewritten shell call is not filtered a second time', async () => {
	const filtered: string[] = [];
	const fake = load(rtk, {
		exec: async request => {
			if (request.args?.[0] === 'rewrite') return {stdout: 'rtk git status', stderr: '', code: 0};
			filtered.push(request.args?.join(' ') ?? '');
			return {stdout: 'condensed output\n', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	const big = `Exit code: 0\n${'line of shell output\n'.repeat(200)}`;

	// this call was rewritten: the marker is set by beforeToolCall
	await firstHook(fake).beforeToolCall?.({toolCallId: 'r1', toolName: 'shell_command', input: {command: 'git status'}});
	const afterRewrite = await firstHook(fake).afterToolCall?.({toolCallId: 'r1', toolName: 'shell_command', result: [{type: 'text', text: big}], isError: false});
	assert.equal(afterRewrite, undefined, 'no second pass for a rewritten call');
	assert.equal(filtered.length, 0, 'and no filter process was spawned');

	// an unrelated call with a fresh id still gets the pass
	const fresh = await firstHook(fake).afterToolCall?.({toolCallId: 'r2', toolName: 'shell_command', result: [{type: 'text', text: big}], isError: false});
	assert.ok(fresh, 'a call rtk did not rewrite still gets condensed');
	assert.equal(filtered.length, 1);

	// and the marker is consumed, so replaying the same id does not suppress the pass forever
	const replay = await firstHook(fake).afterToolCall?.({toolCallId: 'r1', toolName: 'shell_command', result: [{type: 'text', text: big}], isError: false});
	assert.ok(replay, 'the marker was consumed, so a reused id is not suppressed');
});


test('caveman: a level set in one session is read back in the next from the same store', async () => {
	// a second session is the same factory run against a store that already holds a mode.
	const store = new Map<string, unknown>([['mode', 'ultra']]);
	const fake = createFakeCmd({
		exec: async () => ({stdout: '', stderr: '', code: 0}),
	});
	fake.cmd.name = 'caveman';
	fake.cmd.store = {
		get: (key: string) => store.get(key),
		set: async (key: string, value: unknown) => {
			store.set(key, value);
		},
	} as never;
	caveman(fake.cmd as never);

	const getMode = fake.exposed.get('caveman')?.get('getMode') as (() => string) | undefined;
	assert.equal(getMode?.(), 'ultra', 'the stored level is the session start mode');
	assert.match(appends(fake), /Caveman ultra active/);
});

test('compress: a preset applied in one session survives into the next', async () => {
	// one store per mod, shared across both "sessions", which is how the host persists them.
	const make = (name: string, data: Map<string, unknown>) => {
		const fake = createFakeCmd({exec: async () => ({stdout: '', stderr: '', code: 0})});
		fake.cmd.name = name;
		fake.cmd.store = {
			get: (key: string) => data.get(key),
			set: async (key: string, value: unknown) => {
				data.set(key, value);
			},
		} as never;
		return fake;
	};

	const stores = {caveman: new Map<string, unknown>(), ponytail: new Map<string, unknown>(), rtk: new Map<string, unknown>()};

	// session one: all three load, then the preset is applied through their setters
	const sessionOne = {
		caveman: make('caveman', stores.caveman),
		ponytail: make('ponytail', stores.ponytail),
		rtk: make('rtk', stores.rtk),
	};
	caveman(sessionOne.caveman.cmd as never);
	ponytail(sessionOne.ponytail.cmd as never);
	rtk(sessionOne.rtk.cmd as never);
	const driver = createFakeCmd({exec: async () => ({stdout: '', stderr: '', code: 0})});
	driver.cmd.name = 'compress';
	driver.cmd.use = (name: string, key: string) => sessionOne[name as keyof typeof sessionOne]?.exposed.get(name)?.get(key);
	compress(driver.cmd as never);
	runHandler(driver.commands, 'compress', 'balanced');
	await new Promise(resolve => setTimeout(resolve, 0));

	// session two: fresh factories over the same stores
	const sessionTwo = {
		caveman: make('caveman', stores.caveman),
		ponytail: make('ponytail', stores.ponytail),
		rtk: make('rtk', stores.rtk),
	};
	caveman(sessionTwo.caveman.cmd as never);
	ponytail(sessionTwo.ponytail.cmd as never);
	rtk(sessionTwo.rtk.cmd as never);

	const mode = (which: keyof typeof sessionTwo) =>
		(sessionTwo[which].exposed.get(which)?.get('getMode') as (() => string) | undefined)?.();
	assert.equal(mode('caveman'), 'full', 'caveman restored the preset level');
	assert.equal(mode('ponytail'), 'full', 'ponytail restored the preset level');
	assert.equal(mode('rtk'), 'on', 'rtk restored the preset level');
});

test('rtk: the guidance block is byte-stable across rounds, so the prompt cache survives', async () => {
	// the appended bytes are what the provider's prompt cache keys on, so the probe resolving mid-session must not move them.
	for (const version of ['rtk 1.0.1', 'rtk 0.20.0'] as const) {
		const fake = load(rtk, {
			exec: async request => {
				if (request.args?.[0] === '--version') return {stdout: version, stderr: '', code: 0};
				return {stdout: '', stderr: '', code: 1};
			},
		});
		runHandler(fake.commands, 'rtk', 'on');
		const hook = firstHook(fake);
		const firstRound = hook.appendSystemPrompt?.();
		sessionStart(fake);
		await new Promise(resolve => setTimeout(resolve, 20));
		const secondRound = hook.appendSystemPrompt?.();
		assert.equal(firstRound, secondRound, `${version}: the block changed between rounds`);
	}
});

test('rtk: a too-old binary that answers before round one injects no guidance', async () => {
	const fake = load(rtk, {
		exec: async request => {
			if (request.args?.[0] === '--version') return {stdout: 'rtk 0.20.0', stderr: '', code: 0};
			return {stdout: '', stderr: '', code: 1};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	sessionStart(fake);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(appends(fake), '', 'the probe answered before the first round, so the decision already knows');
});

test('compress: a missing sibling is reported as unchanged, never as applied', () => {
	// no siblings loaded at all: the preset cannot reach any mode, so the line must not claim it did.
	const fake = load(compress, {});
	const message = messageOf(runHandler(fake.commands, 'compress', 'max'));
	assert.match(message, /not loaded: caveman, ponytail, rtk/);
	assert.match(message, /caveman=\?/, 'an unloaded mode reads as unknown, not as the preset value');
	assert.doesNotMatch(message, /caveman=ultra/, 'nothing was applied, so nothing may be reported as applied');
});

test('rtk: an explicit --rtk-bin is used instead of probing PATH', async () => {
	const seen: string[] = [];
	const fake = load(rtk, {
		flags: {'rtk-bin': '/custom/place/rtk'},
		exec: async request => {
			seen.push(request.command);
			return {stdout: 'rtk git status', stderr: '', code: 0};
		},
	});
	runHandler(fake.commands, 'rtk', 'on');
	await firstHook(fake).beforeToolCall?.({toolCallId: 'b1', toolName: 'shell_command', input: {command: 'git status'}});
	assert.equal(seen[0], '/custom/place/rtk', 'the flag wins over the probe');
});

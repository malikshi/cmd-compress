// rtk-shapes.test.ts — the tool-output shapes rtk is fed, end to end against the real binary.
// exports: none (node:test)
// used_by: npm test
// related: mods/rtk.ts
// rules: Command Code's own tool output is not rtk's fixture — grep and glob wrap their body in a header or a trailer, and shell_command prefixes an exit status. A filter that folds those away deletes information the model needs, so each shape is pinned here against the installed rtk.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import rtk, {splitSegments, MIN_FILTER_BYTES} from '../mods/rtk.ts';
import {createFakeCmd, firstHook, resultText, runHandler} from './harness.ts';

type ExecRequest = {command: string; args?: string[]; cwd?: string; signal?: AbortSignal};

// Rules: the fake drives the mod's real exec path, so this exercises the same `/bin/sh -c ... < file` redirect production uses.
// Rules: the mod reads `cmd.cwd` for every call, and the fake harness pins it to `/repo`, which does not exist here — a spawn fails ENOENT before rtk ever runs.
function realExec(request: ExecRequest): Promise<{stdout: string; stderr: string; code: number}> {
	return new Promise(resolve => {
		execFile(
			request.command,
			request.args ?? [],
			{cwd: process.cwd(), signal: request.signal, timeout: 10_000, maxBuffer: 32 * 1024 * 1024},
			(error, stdout, stderr) => {
				const code = error && typeof (error as {code?: unknown}).code === 'number' ? Number((error as {code: number}).code) : error ? 1 : 0;
				resolve({stdout: stdout.toString(), stderr: stderr.toString(), code});
			},
		);
	});
}

// Rules: `execFile` is asynchronous, so an ENOENT lands in a callback that a surrounding try/catch never sees — the guard answered true with no rtk installed, so every test in this file failed instead of skipping. `execFileSync` throws synchronously, which is what a probe needs.
function hasRtk(): boolean {
	try {
		execFileSync('rtk', ['--version'], {encoding: 'utf8', timeout: 5000, stdio: 'ignore'});
		return true;
	} catch {
		return false;
	}
}

async function loaded() {
	const fake = createFakeCmd({exec: realExec});
	fake.cmd.name = 'probe';
	rtk(fake.cmd as never);
	firstHook(fake).onSessionStart?.();
	await new Promise(resolve => setTimeout(resolve, 150));
	runHandler(fake.commands, 'rtk', 'on');
	return fake;
}

function globOutput(files: number, dirs: number, pagination = ''): string {
	const paths = Array.from({length: files}, (_, index) => `./src/d${index % dirs}/f${index}.ts`);
	return `Found ${files} files${pagination}\n${paths.join('\n')}`;
}

function grepOutput(matches: number, pagination = ''): string {
	const rows = Array.from({length: matches}, (_, index) => `src/handlers.ts:${index + 1}:  const result = compute(input, options);`);
	const trailer = pagination ? `\n\n[Showing results with pagination = ${pagination}]` : '';
	return `${rows.join('\n')}${trailer}`;
}

test('splitSegments: a glob header is split off, never folded into the path list', () => {
	const text = globOutput(4, 2);
	const split = splitSegments('glob', text);
	assert.equal(split.head, 'Found 4 files\n');
	assert.ok(split.body.startsWith('./src/d0/f0.ts'), 'the body starts at the first path');
	assert.equal(split.tail, '');
});

test('splitSegments: the pagination trailer is split off, so truncation survives the filter', () => {
	const text = grepOutput(40, 'limit: 40');
	const split = splitSegments('grep', text);
	assert.equal(split.tail, '\n\n[Showing results with pagination = limit: 40]');
	assert.ok(split.body.startsWith('src/handlers.ts:1:'));
	assert.equal(split.head, '');
});

test('splitSegments: the shell exit status is split off, so a failure stays visible', () => {
	const text = 'Exit code: 1 (test failure)\nSignal: SIGTERM\nrunning 2 tests\n';
	const split = splitSegments('shell_command', text);
	assert.equal(split.head, 'Exit code: 1 (test failure)\nSignal: SIGTERM\n');
	assert.equal(split.body, 'running 2 tests\n');
});

test('splitSegments: ordinary output is one unsplit body', () => {
	const split = splitSegments('shell_command', 'plain output\n');
	assert.deepEqual(split, {head: '', body: 'plain output\n', tail: ''});
});

test('glob: the count and the pagination notice survive condensation', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = globOutput(260, 10, ' with pagination = limit: 260, offset: 260');
	const result = (await firstHook(fake).afterToolCall?.({
		toolName: 'glob',
		result: [{type: 'text', text: input}],
		isError: false,
	})) as {content: Array<{text: string}>} | undefined;
	assert.ok(result, 'the 4.9 KB result is condensed');
	const out = resultText(result);
	assert.ok(out.startsWith('Found 260 files with pagination = limit: 260, offset: 260\n'), 'the header is verbatim');
	assert.ok(out.length < input.length, 'and the body still shrank');
});

test('glob: every directory in the input is still named', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = globOutput(260, 10);
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'glob', result: [{type: 'text', text: input}], isError: false}));
	for (let dir = 0; dir < 10; dir += 1) {
		assert.ok(out.includes(`./src/d${dir}/`), `dir d${dir} is named`);
	}
});

test('grep: the truncation notice survives, and the match lines still shrink', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = grepOutput(240, 'limit: 240');
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.trimEnd().endsWith('[Showing results with pagination = limit: 240]'), 'the notice is the last thing the model reads');
	assert.ok(out.includes('src/handlers.ts'), 'the file is still named');
	assert.ok(out.length < input.length);
});

test('shell: the exit status survives auto-detect, and the failing test remains', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = [
		'Exit code: 1 (test failure)',
		'running 3 tests',
		'test tests::it_works ... ok',
		'test tests::fails_here ... FAILED',
		'---- tests::fails_here stdout ----',
		"thread 'tests::fails_here' panicked at src/lib.rs:42:5:",
		'assertion `left == right` failed',
		'  left: 1',
		' right: 2',
		'failures:',
		'    tests::fails_here',
		'test result: FAILED. 2 passed; 1 failed; 0 ignored',
	].join('\n');
	const padded = `${input}\n${'filler line that the filter folds away\n'.repeat(40)}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: padded}], isError: false}));
	assert.ok(out.startsWith('Exit code: 1 (test failure)\n'), 'the exit status is still the first line');
	assert.ok(out.includes('fails_here'), 'the failing test is still named');
	assert.ok(out.length < padded.length, 'and the padding was folded');
});

// Rules: the tail keeps one separating newline so `head + filteredBody + tail` stays readable; the assertion trims before comparing.
test('splitSegments: the real glob truncation notice is split off', () => {
	const notice = '(Results are truncated: showing 1-100 of 382 matches, sorted by modification time. Consider using a more specific path or pattern, or retry with offset=100 for the next page.)';
	const text = `Found 100 files\n  src/a.ts\n  src/b.ts\n${notice}`;
	const split = splitSegments('glob', text);
	assert.equal(split.head, 'Found 100 files\n');
	assert.equal(split.tail.trim(), notice);
	assert.ok(!split.body.includes('truncated'));
});

test('splitSegments: the glob timeout notice is split off', () => {
	const notice = '(Search timed out before completing; results may be incomplete. Consider a more specific path or pattern.)';
	const split = splitSegments('glob', `Found 2 files\n  a.ts\n${notice}`);
	assert.equal(split.tail.trim(), notice);
});

test('glob: the truncation notice survives the real filter path', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const notice = '(Results are truncated: showing 1-100 of 382 matches, sorted by modification time. Consider using a more specific path or pattern, or retry with offset=100 for the next page.)';
	const paths = Array.from({length: 200}, (_, index) => `  src/d${index % 5}/f${index}.ts`);
	const input = `Found 100 files\n${paths.join('\n')}\n${notice}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'glob', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.startsWith('Found 100 files\n'), 'the count is verbatim');
	assert.ok(out.trimEnd().endsWith(notice), 'and the truncation notice is the last thing the model reads');
	assert.ok(out.length < input.length, 'the body still shrank');
});

test('a body under the threshold is left alone even when its header is large', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = `Found 3 files\n./a.ts\n./b.ts\n./c.ts`;
	assert.ok(input.length < MIN_FILTER_BYTES);
	assert.equal(
		await firstHook(fake).afterToolCall?.({toolName: 'glob', result: [{type: 'text', text: input}], isError: false}),
		undefined,
	);
});

test('the rewrite never emits a bare `rtk` the shell cannot resolve', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const result = (await firstHook(fake).beforeToolCall?.({
		toolCallId: 'p1',
		toolName: 'shell_command',
		input: {command: 'git status'},
	})) as {input: {command: string}} | undefined;
	assert.ok(result, 'git status rewrites');
	const emitted = result.input.command;
	assert.match(emitted, /\/rtk' git status$/, 'the rewrite is pinned to the absolute path the host can run');
});

// Rules: rtk's `auto_detect_filter` inspects only the first 1024 bytes, so a summary that arrives before that window is what makes the pass fire. The mod leaves detection to rtk rather than reimplementing it.
test('a short command whose body is already minimal is not inflated by the filter', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const body = [
		'test result: FAILED. 400 passed; 1 failed; 0 ignored',
		'',
		'failures:',
		'    tests::bad',
		'',
		'---- tests::bad stdout ----',
		"thread 'tests::bad' panicked at src/lib.rs:42:5:",
		'assertion `left == right` failed',
		'  left: 1',
		' right: 2',
		...Array.from({length: 120}, (_, index) => `  diagnostic line ${index}`),
	].join('\n');
	const input = `Exit code: 1 (test failure)\n${body}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.length < input.length, 'the filter still ran');
	assert.ok(out.startsWith('Exit code: 1 (test failure)\n'), 'and the exit status is still first');
	assert.ok(out.includes('tests::bad'), 'and the failing test is still named');
});

// Rules: splitSegments feeds the filter from the body only, so it must be lossless in content — the envelope is re-attached, never dropped. Whitespace may collapse (the host's blank-line run before a notice is capped at one), but no non-whitespace character may disappear.
test('splitSegments: reassembly preserves every non-whitespace character', () => {
	const bodies = ['', 'x', 'a\nb\n', '\n\n\n', 'Exit code: 1'];
	const heads = ['', 'Found 3 files\n', 'Exit code: 1\n', 'Signal: SIGKILL\n', 'Exit code: 1\nSignal: SIGKILL\n'];
	const tails = ['', '\n[Showing results with pagination = limit: 240]', '\n\n(Results are truncated: showing 1-3 of 9)', '\nCommand aborted'];
	const strip = (value: string) => value.replace(/\s+/g, '');
	for (const tool of ['glob', 'grep', 'shell_command', 'read_file']) {
		for (const head of heads) {
			for (const body of bodies) {
				for (const tail of tails) {
					const input = head + body + tail;
					const split = splitSegments(tool, input);
					assert.equal(strip(split.head + split.body + split.tail), strip(input), `${tool} ${JSON.stringify(input)}`);
					// whatever head is extracted must be the input's own leading bytes, never a rewrite
					assert.ok(input.startsWith(split.head), `${tool}: the head is a verbatim prefix`);
					assert.ok(split.head === '' || head.startsWith(split.head), `${tool}: the head comes from the envelope`);
					// the tail keeps its notice text exactly; only the blank run before it is capped at one
					assert.equal(strip(split.tail), strip(tail), 'the tail notice text is never rewritten');
					assert.ok(!split.tail.startsWith('\n\n\n'), 'a blank-line run is capped, never carried');
				}
			}
		}
	}
});

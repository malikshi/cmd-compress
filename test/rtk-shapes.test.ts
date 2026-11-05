// rtk-shapes.test.ts — the tool-output shapes rtk is fed, end to end against the real binary.
// exports: none (node:test)
// used_by: npm test
// related: mods/rtk.ts
// rules: Command Code's own tool output is not rtk's fixture — grep and glob wrap their body in a header or a trailer, and shell_command prefixes an exit status. A filter that folds those away deletes information the model needs, so each shape is pinned here against the installed rtk.
// agent: unknown | unknown | 2026-11-02 | unknown | initial
// agent: unknown | unknown | 2026-11-05 | unknown | added the CRLF equivalence test and the two local-layout fidelity tests, after measuring that Windows parsing dropped every path list and that the guard refused the condenser's own `NF:` header
// agent: unknown | xai | 2026-11-06 | unknown | review fixes: timestamp-log data-loss test, pass-cache regression, median timing batches, count/path `+N files` assertions

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import rtk, {canRefilterCompressed, checkFidelity, condenseCountRows, condenseGrepRows, condensePaths, hasGrepContext, isGrepRows, splitSegments, MIN_FILTER_BYTES} from '../mods/rtk.ts';
import {createFakeCmd, firstHook, resultText, runHandler, type FakeExecRequest} from './harness.ts';

type ExecRequest = {command: string; args?: string[]; cwd?: string; signal?: AbortSignal};

// Rules: the fake drives the mod's real exec path, so this exercises the same `/bin/sh -c ... < file` redirect production uses.
function realExec(request: ExecRequest): Promise<{stdout: string; stderr: string; code: number}> {
	return new Promise(resolve => {
		execFile(
			request.command,
			request.args ?? [],
			{cwd: request.cwd, signal: request.signal, timeout: 10_000, maxBuffer: 32 * 1024 * 1024},
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

// Rules: the local condenser needs no binary, so its tests must not inherit `realExec` or skip with the rest of this file. A stub that fails every spawn proves the pass never shells out.
function localOnly(exec: (request: FakeExecRequest) => Promise<{stdout: string; stderr: string; code: number}>) {
	const fake = createFakeCmd({exec});
	fake.cmd.name = 'probe';
	rtk(fake.cmd as never);
	// Rules: set the mode through the exposed setter, not `/rtk on`, so these tests isolate the local pass from the on-demand version probe.
	const setMode = fake.exposed.get('probe')?.get('setMode') as ((value: unknown) => boolean) | undefined;
	setMode?.('on');
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

// Rules: formatResult2 follows the exit status with a parenthesised interpretation (`(No matches found)`, `(test failure)` is inline, this one is on its own line). rtk drops it like the exit line, so it belongs in the head — but only right after an `Exit code:` line, or a body starting with `(` would be eaten.
test('splitSegments: the interpreted exit code line is split off with the head', () => {
	const split = splitSegments('shell_command', 'Exit code: 1\n(No matches found)\nrunning 3 tests\n');
	assert.equal(split.head, 'Exit code: 1\n(No matches found)\n');
	assert.equal(split.body, 'running 3 tests\n');

	const bodyParen = splitSegments('shell_command', '(paren body start\nrest\n');
	assert.equal(bodyParen.head, '', 'a body that starts with a parenthesis is untouched');
	assert.equal(bodyParen.body, '(paren body start\nrest\n');
});

test('splitSegments: ordinary output is one unsplit body', () => {
	const split = splitSegments('shell_command', 'plain output\n');
	assert.deepEqual(split, {head: '', body: 'plain output\n', tail: ''});
});

// Rules: Windows is a supported platform (the CI matrix runs windows-latest) and its shell and ripgrep emit CRLF. Every parser splits on `\n`, so a retained `\r` used to break all three: the `$`-anchored notice test stopped matching, `PATH_ROW`'s `[^\s]*$` refused every line, and condensed rows kept a stray `\r` inside the match text. Measured before the fix: a CRLF `Found 300 files` body condensed 0 bytes, and only the last of two consecutive notices was split off.
test('splitSegments: a CRLF result parses exactly like the same result with LF', () => {
	const notice = 'Exit code: 1\nrunning 2 tests\n\n[cwd change to C:\\repo]\n[PowerShell edition: Desktop 5.1]';
	const crlf = notice.replace(/\n/g, '\r\n');
	assert.deepEqual(splitSegments('powershell', crlf), splitSegments('powershell', notice));
	assert.equal(splitSegments('powershell', crlf).tail, '\n\n[cwd change to C:\\repo]\n[PowerShell edition: Desktop 5.1]', 'both consecutive notices are split off');

	const paths = Array.from({length: 300}, (_, index) => `src/d${index % 20}/m${index}.ts`).join('\n');
	assert.notEqual(condensePaths(paths), null, 'the LF form condensed');
	assert.equal(condensePaths(splitSegments('glob', `Found 300 files\n${paths}`.replace(/\n/g, '\r\n')).body), condensePaths(paths), 'and so does the CRLF form');

	const rows = Array.from({length: 60}, (_, index) => `src/m${index % 6}/f${index}.ts:${index + 1}:  return compute(${index});`).join('\n');
	const condensed = condenseGrepRows(splitSegments('grep', rows.replace(/\n/g, '\r\n')).body);
	assert.equal(condensed, condenseGrepRows(rows), 'the row condenser agrees too');
	assert.ok(!condensed?.includes('\r'), 'and no stray CR reaches the model');
});

// Rules: the grep tool's DEFAULT mode is `files_with_matches`, which prints a path list under a `Found N files` header — the same envelope glob uses. The grep filter passes that shape through untouched (measured 4,447 → 4,447 bytes) while the find filter condenses it (→ 620), so the shape decides the filter, not the tool name.
test('splitSegments: grep files-mode splits the same Found header glob does', () => {
	const text = `Found 2 files\n  src/a.ts\n  src/b.ts\n`;
	const split = splitSegments('grep', text);
	assert.equal(split.head, 'Found 2 files\n');
	assert.equal(split.body, '  src/a.ts\n  src/b.ts\n');

	const content = splitSegments('grep', 'src/a.ts:1: hit\nsrc/b.ts:2: hit\n');
	assert.equal(content.head, '', 'content-mode rows have no header');
});

test('grep files-mode is condensed with the find filter, and the count survives', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const paths = Array.from({length: 300}, (_, index) => `src/d${index % 5}/f${index}.ts`);
	const notice = 'Found 300 files with pagination = limit: 300, offset: 300';
	const input = `${notice}\n${paths.join('\n')}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.startsWith(`${notice}\n`), 'the count and the pagination text are verbatim');
	assert.ok(out.length < input.length, 'and the path list shrank, which the grep filter could not do');
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
	// Rules: the directory layout names the path as a `src/` header plus `handlers.ts`, so the literal `src/handlers.ts` need not appear; the file layout prints it whole. Either is a named file.
	assert.ok(out.includes('handlers.ts'), 'the file is still named');
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

// Rules: every notice below is copied from the host's own formatter (`finishContentMode`, `finishCountMode`, the grep timeout path, `formatResult2`'s abort notice), not invented. A regex that only knew the pagination form let the count-mode, the em-dash timeout, and the long timeout notice be folded away by rtk — measured: the tail vanished from the model's view entirely.
test('splitSegments: each notice shape the host actually emits is split off', () => {
	const notices: Array<[tool: string, text: string, tail: string]> = [
		[
			'grep',
			'src/a.ts:1:x\nsrc/b.ts:2:y\n\nFound 10 total occurrences across 2 files with pagination = limit: 2, offset: 2.',
			'Found 10 total occurrences across 2 files with pagination = limit: 2, offset: 2.',
		],
		[
			'grep',
			'src/a.ts:1:x\nsrc/b.ts:2:y\n\nFound 10 total occurrences across 2 files.',
			'Found 10 total occurrences across 2 files.',
		],
		[
			'grep',
			'src/a.ts:1:x\n\n[Search timed out — results above are partial. Narrow the pattern, path, or glob for complete results.]',
			'[Search timed out — results above are partial. Narrow the pattern, path, or glob for complete results.]',
		],
		[
			'shell_command',
			'Exit code: 124\nbuild output\n\nCommand timed out after 120000ms (exit code 124). If this is expected to take longer and is not waiting for interactive input, retry with a larger timeout or run_in_background=true.',
			'Command timed out after 120000ms (exit code 124). If this is expected to take longer and is not waiting for interactive input, retry with a larger timeout or run_in_background=true.',
		],
		['shell_command', 'Exit code: 130\npartial\nCommand aborted', 'Command aborted'],
		// formatResult2 appends these two after the output on the platforms that produce them.
		[
			'shell_command',
			'Exit code: 1\nbuild output\n\n[cwd change to /tmp discarded: outside the workspace — next call starts from the project directory]',
			'[cwd change to /tmp discarded: outside the workspace — next call starts from the project directory]',
		],
		[
			'shell_command',
			'Exit code: 1\nbuild output\n\n[PowerShell edition: Windows PowerShell 5.1]',
			'[PowerShell edition: Windows PowerShell 5.1]',
		],
	];
	for (const [tool, text, tail] of notices) {
		const split = splitSegments(tool, text);
		assert.equal(split.tail.trim(), tail, `${tool}: the notice survives`);
		assert.ok(!split.body.includes('pagination = limit: 2'), `${tool}: the notice is not left in the body`);
	}
});

test('splitSegments: the count-mode notice survives the real filter path', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	// Rules: a count-mode body groups well — 40 files x 10 hits — so rtk actually shrinks it; a scattered 1-per-file body is returned unchanged (never_worse) and would prove nothing about the trailer.
	const rows = Array.from({length: 40}, (_, file) =>
		Array.from({length: 10}, (_, hit) => `src/file${file}.ts:${hit + 1}:  const x = compute(input)`).join('\n'),
	);
	const notice = 'Found 400 total occurrences across 40 files with pagination = limit: 400, offset: 400.';
	const input = `${rows.join('\n')}\n\n${notice}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.trimEnd().endsWith(notice), 'the count and the truncation notice are the last thing the model reads');
	assert.ok(out.length < input.length, 'and the body still shrank');
});

// Rules: `formatResult2` appends the abort notice after the output, and it is longer than a plain "Command aborted" — the earlier regex demanded a bare `ms`, so the whole sentence was fed to the filter and folded away. The body is a pytest shape, which is what makes the auto-detect pass fire at all.
test('splitSegments: the timed-out shell notice survives the real filter path', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const notice = 'Command timed out after 120000ms (exit code 124). If this is expected to take longer and is not waiting for interactive input, retry with a larger timeout or run_in_background=true.';
	const body = [
		'running 3 tests',
		'test tests::it_works ... ok',
		'test tests::fails_here ... FAILED',
		'failures:',
		'    tests::fails_here',
		'test result: FAILED. 2 passed; 1 failed; 0 ignored',
		...Array.from({length: 120}, (_, index) => `filler line that the filter folds away ${index}`),
	].join('\n');
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: `Exit code: 124\n${body}\n\n${notice}`}], isError: false}));
	assert.ok(out.startsWith('Exit code: 124\n'), 'the exit status is still the first line');
	assert.ok(out.trimEnd().endsWith(notice), 'and the timeout notice is still the last');
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
	// Rules: the pin is an absolute path in this shell's own quote style — single quotes on POSIX, double on Windows, where the binary is rtk.exe. Asserting one style made this pass on Linux and fail on the Windows runner.
	const absolute = process.platform === 'win32' ? /"[A-Za-z]:.*rtk\.exe" git status$/ : /'\/.*\/rtk' git status$/;
	assert.match(emitted, absolute, 'the rewrite is pinned to the absolute path the host can run');
	assert.doesNotMatch(emitted, /(^|[\s&|;])rtk git status$/, 'a bare name would resolve from a PATH the host may not have');
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

/* ------------------------------------------- the local content-mode condenser */

// Rules: rtk's own grep filter repeats the path and the full match text on every row, so it saves almost nothing on the shapes a coding agent actually greps: 20 files x 5 hits 6,850 -> 6,591 (3%), 30 files x 1 hit 0%. These tests pin the local replacement, which runs with no binary and must never lose a file.
const grepBody = (files: number, perFile: number, make = (file: number, hit: number) => `\tconst value${file}_${hit} = compute(input);`): string =>
	Array.from({length: files}, (_, file) =>
		Array.from({length: perFile}, (_, hit) => `src/mod${file}.ts:${hit + 1}:${make(file, hit)}`).join('\n'),
	).join('\n');

test('condenseGrepRows: identical lines collapse to one row with their numbers joined', () => {
	const input = grepBody(3, 4, () => '\tconst value = compute(input);');
	const out = condenseGrepRows(input);
	assert.ok(out, 'the body is condensed');
	assert.match(out, /^12 matches in 3F:/);
	// Rules: either layout is valid; both join a repeated line's numbers into one row. The directory layout carries the path as a `src/` header plus `mod0.ts:…`, the file layout as `[file] src/mod0.ts`.
	const joined = /mod0\.ts:1,2,3,4:\tconst value = compute\(input\);|1,2,3,4:\tconst value = compute\(input\);/;
	assert.match(out, joined, 'the four line numbers are joined on one row');
	assert.ok(out.includes('mod0.ts'), 'the file is named');
	assert.ok(out.length < input.length);
});

test('condenseGrepRows: every file is still named, even past the per-file cap', () => {
	const rows = Array.from({length: 40}, (_, file) =>
		Array.from({length: 6}, (_, hit) => `src/m${file}.ts:${hit + 1}:\tconst distinct${hit} = compute();`).join('\n'),
	).join('\n');
	const out = condenseGrepRows(rows, 3);
	assert.ok(out, 'condensed');
	for (let file = 0; file < 40; file += 1) assert.ok(out.includes(`m${file}.ts`), `file m${file} is named`);
	assert.match(out, /\+3 more lines/, 'the elided rows are counted');
});

test('condenseGrepRows: a body with any non-row line is refused, so a log is never regrouped', () => {
	assert.equal(condenseGrepRows('error: boom\nsrc/a.ts:1:\tconst x = 1;\n'.repeat(30)), null);
	assert.equal(condenseGrepRows('src/a.ts:1:x\nsrc/a.ts-2-context line\n'.repeat(30)), null, 'a -A/-B/-C context row opts out');
	assert.equal(condenseGrepRows('src/a.ts:1:only one row'), null);
});

// Rules: the directory layout prints a `dir/  (N)` header and lists `name:numbers:text`, so the full path is the header plus the name — that is how the model reopens a file. The file layout prints the path verbatim. Both are checked by reconstructing the original path from the output.
test('condenseGrepRows: nested, spaced, Windows and root-relative paths all survive', () => {
	for (const path of ['src/a/b/c/f.ts', 'src/my dir/f.ts', 'C:\\src\\f.ts', 'f.ts', 'pkg/mod/src/f.ts']) {
		const rows = Array.from({length: 20}, (_, index) => `${path}:${index + 1}:\tconst x = 1;`).join('\n');
		const out = condenseGrepRows(rows);
		assert.ok(out, `${path} is condensed`);
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		const dir = slash >= 0 ? path.slice(0, slash + 1) : './';
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		const reconstructable = out.includes(path) || (out.includes(dir) && out.includes(name));
		assert.ok(reconstructable, `${path} is reconstructable from the output:\n${out}`);
	}
});

test('condenseGrepRows: a body that would not shrink is refused', () => {
	assert.equal(condenseGrepRows(Array.from({length: 40}, (_, index) => `f${index}.ts:1:x`).join('\n')), null);
});

// Rules: the row pattern used to backtrack exponentially on a dotted line — one grep hit inside a minified bundle is exactly that shape, and this ran on every grep, glob and shell result. Measured on the old pattern: 122 ms at 63 chars, 698 ms at 5.6 KB, no answer past that. The parser is now one linear match plus a constant-time path test, so a 1 MB dotted row must finish in single-digit milliseconds.
test('condenseGrepRows: a very long dotted row stays linear', () => {
	for (const size of [200, 2_000, 20_000, 200_000]) {
		const line = `src/min.js:1:${'a.b'.repeat(size)}`;
		const started = performance.now();
		condenseGrepRows(`${line}\n`);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 500, `${size} dotted segments took ${elapsed.toFixed(0)} ms`);
	}
	const longPath = `./${'a.b/'.repeat(20_000)}c.ts`;
	const started = performance.now();
	condensePaths(`${longPath}\n${longPath}\n`);
	assert.ok(performance.now() - started < 500, 'and the path condenser stays linear too');
});

// Rules: rtk's find filter names only some directories on a wide tree (measured 19 of 60), so the local path pass exists to keep every one. It must refuse a match row, or it would read the line number into the file name.
test('condensePaths: every directory is named and each file list is capped', () => {
	const paths = Array.from({length: 240}, (_, index) => `./src/a${index % 24}/module-name${index}.ts`).join('\n');
	const out = condensePaths(paths);
	assert.ok(out, 'a path list is condensed');
	assert.match(out, /^240 files in 24 dirs:/);
	for (let dir = 0; dir < 24; dir += 1) assert.ok(out.includes(`./src/a${dir}/`), `dir a${dir} is named`);
	assert.match(out, /\+4 files\n/, 'the elided files are counted and labelled');
});

test('condensePaths: a match row is refused, so a grep body is left to the row condenser', () => {
	const rows = Array.from({length: 40}, (_, index) => `src/f${index}.ts:${index + 1}:hit`).join('\n');
	assert.equal(condensePaths(rows), null);
});

// Rules: the host's count mode emits `path:count` (`finishCountMode`: `compactPath(n.path):n.count`), which `grepBodyRow` cannot recognise because it needs a third field. That row used to reach the path tree and print `file0.ts:1`, where `1` is the match COUNT sitting exactly where a line number goes — a model reading that reopens the wrong line. It now has its own layout, where every number is labelled, so no position in the output can be read as a line number.
test('condenseCountRows: a count body is grouped, and no number is left where a line number goes', () => {
	const count = Array.from({length: 40}, (_, index) => `src/file${index}.ts:${(index % 10) + 1}`).join('\n');
	const out = condenseCountRows(count);
	assert.ok(out, 'a count body is condensed');
	assert.match(out, /^40 files in 1 dirs:/);
	assert.match(out, /src\/  \(40 files, \d+ hits\)/, 'the directory line states both counts');
	assert.match(out, /file0\.ts \(1\)/, 'each count is printed with the file it belongs to');
	assert.match(out, /\+34 files/, 'the elided file names are counted and labelled');
	assert.doesNotMatch(out, /^\s+\S+:\d+/m, 'no bare `name:number` position can be misread as a line number');
	assert.ok(out.length < count.length, 'and it is smaller than the input');
});

test('condenseCountRows: a path list, a match body and a log are all refused', () => {
	assert.equal(condenseCountRows(Array.from({length: 40}, (_, index) => `src/f${index}.ts`).join('\n')), null, 'a bare path has no count');
	assert.equal(condenseCountRows(Array.from({length: 40}, (_, index) => `src/f${index}.ts:${index}:hit`).join('\n')), null, 'a match row has text after the number');
	assert.equal(condenseCountRows('2026-11-04 12:00:01: INFO started\n2026-11-04 12:00:02: INFO done'), null, 'a timestamp log is not a count body');
	assert.equal(condenseCountRows('src/a.ts:1'), null, 'a single row is not worth a layout');
});

// Rules: a path that appears on more than one row must become ONE entry whose count is the sum, never two entries under the same name. Measured: six `src/m0/f0.ts` rows printed `f0.ts` six times and the directory header claimed more files than existed, so the model reads phantom files and the per-directory count overstates the tree. A duplicate path is also what a paged or concatenated count body produces, so it is reachable even though `finishCountMode` emits one row per file.
// Rules: the fixture is large enough to clear MIN_LOCAL_GAIN — a three-file body is declined by `worthIt`, which is correct behaviour, so a small fixture would test the filter instead of the dedupe.
test('condenseCountRows: a repeated path is summed into one entry, not listed twice', () => {
	const rows: string[] = [];
	for (let index = 0; index < 12; index += 1) {
		rows.push(`src/m0/f0.ts:${index + 1}`);
		rows.push(`src/m0/f${index + 1}.ts:2`);
		rows.push(`src/m1/f${index + 20}.ts:3`);
	}
	const count = rows.join('\n');
	const out = condenseCountRows(count);
	assert.ok(out, 'the body is condensed');
	assert.equal(out.match(/f0\.ts/g)?.length, 1, 'the repeated path is named once');
	assert.match(out, /f0\.ts \(78\)/, 'its count is the sum of all twelve rows');
	assert.match(out, /^25 files in 2 dirs:/, 'distinct files are counted, not rows');
	assert.match(out, /src\/m0\/  \(13 files, 102 hits\)/, 'the directory claims the distinct file count and the total hits');
});

test('condensePaths: a count-mode row is refused, since its number is a count and not a line', () => {
	const count = Array.from({length: 40}, (_, index) => `src/file${index}.ts:${(index % 10) + 1}`).join('\n');
	assert.equal(condensePaths(count), null, 'a `path:count` row is not a bare path');

	const oneHit = Array.from({length: 40}, (_, index) => `src/file${index}.ts:1`).join('\n');
	assert.equal(condensePaths(oneHit), null, 'and a uniform count is refused too, not read as line 1 of forty files');
});

test('condensePaths: a prose line is refused', () => {
	const mixed = [...Array.from({length: 40}, (_, index) => `src/f${index}.ts`), 'error: gone wrong'].join('\n');
	assert.equal(condensePaths(mixed), null);
});

// Rules: the local condensers now run on EVERY shell result before rtk, so each must refuse a shape that is not its own. A build log, a git status, a diff, an ls listing and a JSON blob all have `:` or path-like fragments; regrouping one would corrupt output that rtk used to leave alone.
test('the local condensers refuse every non-grep shell shape', () => {
	const shapes: Record<string, string> = {
		'git status': Array.from({length: 60}, (_, index) => `\tmodified:   src/file${index}.ts`).join('\n'),
		'cargo errors': Array.from({length: 60}, (_, index) => `error[E0${index}]: cannot find value \`x${index}\` in this scope\n  --> src/lib.rs:${index + 1}:5`).join('\n'),
		'ls -l': Array.from({length: 60}, (_, index) => `-rw-r--r-- 1 u u 1234 ${index} file${index}.ts`).join('\n'),
		'npm warnings': Array.from({length: 60}, (_, index) => `npm WARN deprecated pkg@1.${index}.0: use something else`).join('\n'),
		diff: Array.from({length: 60}, (_, index) => `+  const x = ${index};`).join('\n'),
		pytest: Array.from({length: 60}, (_, index) => `tests/test_${index}.py::test_${index} PASSED [ ${index}%]`).join('\n'),
		json: `{\n${Array.from({length: 60}, (_, index) => `  "key${index}": "value${index}",`).join('\n')}\n}`,
	};
	for (const [name, body] of Object.entries(shapes)) {
		assert.equal(condenseGrepRows(body), null, `${name} is not regrouped as match rows`);
		assert.equal(condensePaths(body), null, `${name} is not regrouped as paths`);
	}
});

// Rules: a repeat command is a cache hit that costs no process; a deny is never cached, because the user can edit their rtk rules mid-session and a stale deny would block a command that is now allowed.
test('rewrite: a repeated command spawns rtk once, and a deny is always re-asked', async () => {
	let calls = 0;
	const fake = localOnly(async (request: FakeExecRequest) => {
		calls += 1;
		if (request.args?.[0] === '--version') return {stdout: 'rtk 1.1.0', stderr: '', code: 0};
		if (request.args?.[1] === 'rm -rf /') return {stdout: 'blocked by rule', stderr: '', code: 2};
		return {stdout: 'rtk git status', stderr: '', code: 0};
	});
	firstHook(fake).onSessionStart?.();
	await new Promise(resolve => setTimeout(resolve, 50));
	const call = () => firstHook(fake).beforeToolCall?.({toolCallId: `c${calls}`, toolName: 'shell_command', input: {command: 'git status'}});

	calls = 0;
	await call();
	const afterFirst = calls;
	await call();
	assert.equal(calls, afterFirst, 'the second identical command spawned nothing');

	calls = 0;
	await firstHook(fake).beforeToolCall?.({toolCallId: 'd1', toolName: 'shell_command', input: {command: 'rm -rf /'}});
	await firstHook(fake).beforeToolCall?.({toolCallId: 'd2', toolName: 'shell_command', input: {command: 'rm -rf /'}});
	assert.equal(calls, 2, 'a denied command is asked again every time');
});

// Rules: a cached `pass` is the mirror of a stale deny. The user can add a rule mid-session; a command that passed before the edit must be asked again, or the new rule is bypassed for the rest of the session. Only a rewrite verdict is stable enough to cache.
test('rewrite: a pass is re-asked, so a new deny is not bypassed', async () => {
	let calls = 0;
	let deny = false;
	const fake = localOnly(async (request: FakeExecRequest) => {
		if (request.args?.[0] === '--version') return {stdout: 'rtk 1.1.0', stderr: '', code: 0};
		calls += 1;
		return deny
			? {stdout: 'pipeline rule forbids it', stderr: '', code: 2}
			: {stdout: '', stderr: '', code: 1};
	});
	const call = (id: string) => firstHook(fake).beforeToolCall?.({toolCallId: id, toolName: 'shell_command', input: {command: 'git status'}});

	assert.equal(await call('p1'), undefined, 'the first call has no rewrite');
	deny = true;
	const blocked = (await call('p2')) as {block?: boolean; additionalContext?: string} | undefined;
	assert.equal(calls, 2, 'the second call spawned rtk instead of serving the cached pass');
	assert.equal(blocked?.block, true, 'the newly added rule blocks the command');
	assert.match(blocked?.additionalContext ?? '', /pipeline rule forbids it/);
});

// Rules: the local condensers cost no process, so they must not be gated on the binary or on the 1,200-byte spawn floor. This is the whole point on a machine with no rtk: the grep result still shrinks. A stub whose every spawn fails is a session with no binary.
test('grep: a body below the spawn floor still shrinks, with no process', async () => {
	const spawned: string[] = [];
	const fake = localOnly(async (request: FakeExecRequest) => {
		spawned.push(request.args?.join(' ') ?? '');
		return {stdout: '', stderr: 'ENOENT', code: 1};
	});
	const rows = Array.from({length: 16}, (_, file) =>
		Array.from({length: 2}, (_, hit) => `src/m${file}.ts:${hit + 1}:x`).join('\n'),
	).join('\n');
	assert.ok(rows.length < MIN_FILTER_BYTES, `the fixture is under the floor (${rows.length})`);
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: rows}], isError: false}));
	assert.ok(out.length < rows.length * 0.7, `expected a cut with no binary, got ${rows.length} -> ${out.length}`);
	assert.match(out, /^32 matches in 16F:/, 'the rows were grouped, with each file named once');
	assert.deepEqual(spawned, [], 'no process was spawned');
});

test('glob: a path list still shrinks with no binary', async () => {
	const fake = localOnly(async () => ({stdout: '', stderr: 'ENOENT', code: 1}));
	const input = `Found 40 files\n${Array.from({length: 40}, (_, index) => `./src/d${index % 4}/file-name-${index}.ts`).join('\n')}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'glob', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.length < input.length, `expected a cut, got ${input.length} -> ${out.length}`);
	for (let dir = 0; dir < 4; dir += 1) assert.ok(out.includes(`./src/d${dir}/`), `dir d${dir} is named`);
});

test('grep: a content-mode body is condensed locally, without spawning rtk', async () => {
	const spawned: string[] = [];
	const fake = localOnly(async (request: FakeExecRequest) => {
		spawned.push(request.args?.join(' ') ?? '');
		return {stdout: '', stderr: '', code: 1};
	});
	const input = grepBody(20, 5, () => '\t  const result = compute(input, options);');
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.match(out, /^100 matches in 20F:/);
	assert.ok(out.length < input.length / 2, `expected a >50% cut, got ${input.length} -> ${out.length}`);
	assert.deepEqual(spawned, [], 'no filter process was spawned for a grep body');
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

// Rules: the sticky-anchor rewrite trimmed the blank padding before matching, so a trailing-whitespace notice must still be recognised — the old `[\s]*$` consumed that whitespace, and dropping it there would fold the notice into the body and lose it. Pinned so the optimisation cannot regress the behaviour it replaced.
test('splitSegments: a notice followed by trailing whitespace is still split off', () => {
	const split = splitSegments('shell_command', 'body\n\n[Showing results with pagination = limit: 40]   \n  ');
	assert.equal(split.body, 'body', 'the notice never reaches the body rtk filters');
	assert.equal(split.tail, '\n\n[Showing results with pagination = limit: 40]');
});

// Rules: a single wall-clock sample is not a regression signal in this container. Measured: the same linear call took 22 ms on two runs and 747 ms on a third while an unrelated no-op loop showed the same stall. The median of several batches ignores a stalled batch and still fails loudly if the old quadratic path returns.
function medianMs(run: () => void, batches = 5, perBatch = 3): number {
	const samples: number[] = [];
	for (let batch = 0; batch < batches; batch += 1) {
		const started = performance.now();
		for (let index = 0; index < perBatch; index += 1) run();
		samples.push((performance.now() - started) / perBatch);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
}

// Rules: `splitSegments` runs on every large shell result before the filter, so it must be linear. The original trailer pattern began with `\n*` and ended with `[\s]*$`, which made the engine retry every offset and re-scan the tail each time: measured 825 ms at 20k newlines and 9.8 s at 60k, on a result the session is blocked on. A 200k-newline body must stay in the low milliseconds, and the notice must still be found.
test('splitSegments: a long blank run is handled in linear time, not quadratic', () => {
	const input = 'Exit code: 1\nbody\n' + '\n'.repeat(200_000) + '[Showing results with pagination = limit: 40]';
	const elapsed = medianMs(() => splitSegments('shell_command', input));
	const split = splitSegments('shell_command', input);
	assert.equal(split.head, 'Exit code: 1\n', 'the exit status is still split as the head');
	assert.equal(split.body, 'body', 'the body is what is left after the blank run');
	assert.equal(split.tail, '\n\n[Showing results with pagination = limit: 40]', 'and the notice is still found at the end');
	assert.ok(elapsed < 200, `200k newlines took ${elapsed.toFixed(0)}ms median; the old pattern took seconds at 60k`);
});

// Rules: the same shape without a notice must also stay linear — this is the case that made the quadratic path worst, because every attempt failed.
test('splitSegments: a long blank run with no notice stays linear too', () => {
	const input = `Exit code: 1\n${'x'.repeat(200_000)}\n${'\n'.repeat(100_000)}`;
	const elapsed = medianMs(() => splitSegments('shell_command', input));
	const split = splitSegments('shell_command', input);
	assert.equal(split.tail, '');
	assert.ok(elapsed < 200, `took ${elapsed.toFixed(0)}ms median`);
});

// Rules: this file's whole value is running against a real binary. When rtk is absent every test here skips, and a skipped suite looks exactly like a passing one in a summary line — which is how this coverage went quiet before CI installed rtk. The guard turns that silence into a visible note instead of a hidden skip, and CI fails the install step rather than reaching here without the binary.
test('rtk-shapes: note when the real binary is absent, so the skips are never invisible', t => {
	if (hasRtk()) {
		assert.ok(true, 'rtk is installed; every test in this file ran');
		return;
	}
	t.diagnostic('rtk is not installed — this file skipped all of its real-binary tests. Run `node scripts/install-rtk.mjs`.');
});

/* ------------------------------------------- the declined-baseline second pass */

// Rules: rtk's search filter emits its faithful baseline whenever capping would not shrink the output, so a multi-file grep arrives uncompressed even though rtk handled it. Measured on the real binary: 4,026 -> 4,026 bytes for `grep -rn export mods`, and 1,348 bytes recoverable by one more pass.
test('a declined multi-file grep is recognised as compressible', () => {
	const rows = Array.from({length: 40}, (_, index) => `mods/rtk.ts:${index + 1}:export const value${index} = ${index};`).join('\n');
	assert.equal(isGrepRows(rows), true);
	assert.equal(canRefilterCompressed(rows), true, 'no recovery marker and match-list rows, so a second pass is safe');
});

// Rules: the guard exists because a blind second pass DELETED all 9 `rtk recall` hints from grouped output in measurement — the filter folds lines it cannot parse, and a recall hash is unrecoverable once its hint is gone. Every marker rtk emits is pinned here, taken from its own source rather than guessed.
test('every rtk recovery marker blocks the second pass, so no recall hash is ever dropped', () => {
	const rows = Array.from({length: 40}, (_, index) => `mods/rtk.ts:${index + 1}:export const value${index} = ${index};`).join('\n');
	const markers = [
		'100 matches in 4 files:\n\n' + rows,
		'100 matches in 4F:\n\n' + rows,
		rows + '\n  +15 more in ./f0.ts',
		rows + '\n+3 more files',
		rows + '\n[+12 hidden: rtk recall 9f8e7d]',
		rows + '\n[full output: rtk recall 9f8e7d]',
		rows + '\n... +5 more files',
	];
	for (const text of markers) {
		assert.equal(canRefilterCompressed(text), false, `must skip: ${text.slice(-40)}`);
	}
});

// Rules: `pipe_cmd.rs` abbreviates the file count to `NF:` where `search.rs` spells out `N files:`. Measured from the real binary: `rtk pipe -f grep` on 60 rows prints `60 matches in 5F:`. The assertion isolates the marker — the same bare rows are compressible, and prefixing the `NF:` header is what makes them skip. Without this the test would pass on the row-shape check alone and never exercise the marker it exists for.
test('the abbreviated NF: grouping header is a recovery marker too', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const rows = Array.from({length: 60}, (_, index) => `mods/rtk.ts:${index + 1}:export const value${index} = ${index};`).join('\n');
	const grouped = execFileSync('rtk', ['pipe', '-f', 'grep'], {encoding: 'utf8', input: `${rows}\n`, timeout: 5000});
	assert.match(grouped, /matches in \d+F:/, 'the real binary prints the abbreviated header');

	assert.equal(isGrepRows(rows), true, 'the bare rows are a match list');
	assert.equal(canRefilterCompressed(rows), true, 'so on their own they are compressible');
	assert.equal(canRefilterCompressed(`60 matches in 5F:\n\n${rows}`), false, 'the NF: header is what marks them as already grouped');
});

// Rules: a diff, a git log, and a build log all contain colons and digits, so the row test must not fire on them — re-filtering a format rtk did not decline was measured as byte-identical (0 bytes, 12 real commands), which is a wasted process rather than a loss, but still not worth spawning.
// Rules: a timestamped log is the dangerous form. `2026-11-04 12:00:01: INFO …` has the `path:line:text` shape unless the path is checked like a file; without that check a rewritten call's log was accepted as a grep baseline, grouped, and returned as a summary that dropped every line.
test('output that is not a match list is never re-filtered', () => {
	const samples: Array<[string, string]> = [
		['diff', '+++ b/mods/rtk.ts\n--- a/mods/rtk.ts\n@@ -1,4 +1,4 @@\n-const a = 1;\n+const a = 2;'],
		['git log', 'f7e35e0 chore: release 0.1.1\nd18dfed fix(rtk): stop deleting host envelopes'],
		['build log', '> tsc --noEmit\n\nsrc/a.ts(12,5): error TS2322: Type string is not assignable'],
		['json', '{\n  "name": "cmd-compress",\n  "version": "0.1.1"\n}'],
		['timestamp log', Array.from({length: 20}, (_, index) => `2026-11-04 12:00:${String(index).padStart(2, '0')}: INFO step ${index}`).join('\n')],
	];
	for (const [name, text] of samples) {
		assert.equal(canRefilterCompressed(text), false, `${name} must not be re-filtered`);
	}
});

test('a timestamped log is not accepted as a grouped match list', () => {
	const log = Array.from({length: 20}, (_, index) => `2026-11-04 12:00:${String(index).padStart(2, '0')}: INFO step ${index}`).join('\n');
	const grouped = '20 matches in 1F:\n\n[file] 2026-11-04 12 (20):\n  00:00: INFO step 0\n  +19';
	assert.equal(isGrepRows(log), false, 'the log has no file-like path');
	assert.equal(canRefilterCompressed(log), false, 'the declined-baseline path is closed');
	const report = checkFidelity(log, grouped, true);
	assert.equal(report.ok, false, 'the grouping is a wrong format guess');
	assert.match(report.lost.join(' '), /format:/);
});

// Rules: end to end through the real hooks, the whole point is that a rewritten call normally skips and this one does not.
test('shell: a rewritten call carrying rtk\'s declined baseline is condensed, a marked one is not', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const rows = Array.from({length: 60}, (_, index) => `mods/rtk.ts:${index + 1}:export const value${index} = ${index};`).join('\n');
	const before = await firstHook(fake).beforeToolCall?.({toolCallId: 'declined', toolName: 'shell_command', input: {command: 'grep -rn export mods'}});
	assert.ok(before, 'the command rewrites, so the second pass is gated');

	const declined = await firstHook(fake).afterToolCall?.({
		toolCallId: 'declined',
		toolName: 'shell_command',
		result: [{type: 'text', text: rows}],
		isError: false,
	});
	const declinedText = resultText(declined);
	assert.ok(declinedText && declinedText.length < rows.length, 'the declined baseline was condensed after all');
	assert.ok(declinedText.includes('mods/rtk.ts'), 'and the file is still named');

	const marked = `100 matches in 2 files:\n\n${rows}\n[+12 hidden: rtk recall 9f8e7d]`;
	await firstHook(fake).beforeToolCall?.({toolCallId: 'marked', toolName: 'shell_command', input: {command: 'grep -rn export mods'}});
	const kept = await firstHook(fake).afterToolCall?.({
		toolCallId: 'marked',
		toolName: 'shell_command',
		result: [{type: 'text', text: marked}],
		isError: false,
	});
	assert.equal(kept, undefined, 'a result with a recovery hint is left exactly as rtk emitted it');
});

/* ------------------------------------------------------------ colour */

// Rules: a test runner or build tool emits colour by default, and rtk's filters pass every escape through — measured on 10,110 bytes of realistic coloured test output, `rtk pipe` returned all 10,110 bytes with all 720 escapes intact, while the same text without them was 6,750 bytes (33.2% smaller). Colour carries nothing the model reads, so the mod removes it even when the rtk pass declines.
test('a coloured result loses its escapes and keeps every fact', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const rows = Array.from({length: 120}, (_, index) =>
		`\u001B[1;31mFAILED\u001B[0m tests::case_${index} \u001B[2m(src/lib.rs:${index})\u001B[0m`,
	);
	const input = `Exit code: 1\n${rows.join('\n')}\n`;
	const before = input.length;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(!out.includes('\u001B['), 'no escape survives');
	assert.ok(out.startsWith('Exit code: 1\n'), 'the exit status is still first');
	assert.ok(out.includes('tests::case_119'), 'and the last failing test is still named');
	assert.ok(out.length < before, 'and the result is smaller');
});

// Rules: the strip must not be a rewrite. `stripAnsi` is the whole change for a result below the spawn floor, so it is asserted on its own — including that an ordinary result is returned byte-identical, and that an OSC hyperlink or title is removed rather than left half-consumed.
test('stripAnsi removes colour, cursor, and OSC sequences, and leaves plain text alone', async () => {
	const {stripAnsi} = await import('../mods/rtk.ts');
	assert.equal(stripAnsi('plain text\n'), 'plain text\n');
	assert.equal(stripAnsi('\u001B[31mred\u001B[0m'), 'red');
	assert.equal(stripAnsi('\u001B[1;38;5;196mbold\u001B[m'), 'bold');
	assert.equal(stripAnsi('\u001B]8;;https://x.dev\u0007link\u001B]8;;\u0007'), 'link', 'an OSC hyperlink is consumed whole');
	assert.equal(stripAnsi('\u001B]0;title\u0007body'), 'body', 'so is an OSC title');
	assert.equal(stripAnsi('a\u001B[2Kb'), 'ab', 'a cursor clear is stripped');
	assert.equal(stripAnsi('keep \u001B not an escape'), 'keep \u001B not an escape', 'a lone ESC is not swallowed');
});

// Rules: the colour strip runs below the byte floor too. A short coloured result used to be returned untouched because the floor gated every path, so a 900-byte failing-test summary reached the model with escapes and no filter could help it.
test('a short coloured result is still stripped below the spawn floor', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const input = `Exit code: 1\n\u001B[31mFAILED\u001B[0m tests::short_case\n`;
	assert.ok(input.length < MIN_FILTER_BYTES, 'below the floor');
	const result = await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false});
	const out = resultText(result);
	assert.equal(out, 'Exit code: 1\nFAILED tests::short_case\n');
});

// Rules: colour is stripped from a grep result too, not only from shell output — a coloured `rg` piped through the mod took the explicit-filter branch, which never applied the strip.
test('a coloured grep result is stripped, and its count survives', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const rows = Array.from({length: 200}, (_, index) => `\u001B[35msrc/a.ts:${index + 1}:\u001B[0m  \u001B[33mconst x\u001B[0m = 1;`);
	const input = `${rows.join('\n')}\n\n[Showing results with pagination = limit: 200]`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(!out.includes('\u001B['), 'no escape survives the grep branch');
	assert.ok(out.trimEnd().endsWith('[Showing results with pagination = limit: 200]'), 'the notice is still last');
});

/* ------------------------------------------------------------ spill pointer */

// Rules: the host truncates a large foreground result in the MIDDLE and puts a two-line pointer there, not at the end. Measured against the real binary: a 2,951-byte pytest result carrying that pair came back from `rtk pipe` at 296 bytes with BOTH lines gone, so the model lost its only route to the rest of the output.
test('the host spill pointer survives a compressed shell result', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const truncation = '[... output truncated: 900000 chars total, showing first 12000 and last part ...]';
	const pointer = '[full output saved to: /tmp/cmd-foreground-abc.log — read it with read_file (offset/limit) or grep]';
	const body = [
		'test result: FAILED. 120 passed; 1 failed; 0 ignored',
		'',
		'failures:',
		'    tests::fails_here',
		truncation,
		pointer,
		'',
		'---- tests::fails_here stdout ----',
		"thread 'tests::fails_here' panicked at src/lib.rs:42:5:",
		'assertion `left == right` failed',
		'  left: 1',
		' right: 2',
		...Array.from({length: 60}, (_, index) => `    note line ${index} that a filter folds away`),
	];
	const input = `Exit code: 1 (test failure)\n${body.join('\n')}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.includes(pointer), 'the pointer to the full output is still there');
	assert.ok(out.includes(truncation), 'and so is the truncation notice');
	assert.ok(out.startsWith('Exit code: 1 (test failure)\n'), 'the exit status is still first');
	assert.ok(out.includes('fails_here'), 'and the failing test is still named');
	assert.ok(out.length < input.length, 'and the body still shrank');
});

// Rules: the extractor is the whole guarantee, so it is asserted directly — both pointer forms, the "could not be persisted" fallback, and a body that happens to contain a similar but different bracket.
test('extractSpillNotices lifts both pointer forms and nothing else', async () => {
	const {extractSpillNotices} = await import('../mods/rtk.ts');
	const truncation = '[... output truncated: 900000 chars total, showing first 12000 and last part ...]';
	const saved = '[full output saved to: /tmp/x.log — read it with read_file (offset/limit) or grep]';
	const failed = '[full output could not be persisted]';

	const one = extractSpillNotices(`a\n${truncation}\n${saved}\nb`);
	assert.equal(one.body, 'a\n\n\nb', 'the lines are blanked, so the body keeps its shape');
	assert.equal(one.notices, `${truncation}\n${saved}`);

	const two = extractSpillNotices(`x\n${failed}\ny`);
	assert.equal(two.notices, failed);
	assert.equal(two.body, 'x\n\ny');

	const none = extractSpillNotices('[not a pointer] plain [full output stays here]');
	assert.equal(none.notices, '', 'an unrelated bracket is not a pointer');
	assert.equal(none.body, '[not a pointer] plain [full output stays here]');
});

// Rules: this runs on every result, and the split+join below costs 31 ms on a 700 KB body even when no pointer is present — which is almost always. The marker pre-check is what makes the common case free, and it must return the input byte-identical rather than a renormalised copy.
// Rules: the timing assertion is a MEDIAN of repeated batches, not a mean of one batch. Measured: a single 20-call batch occasionally reported 146 ms/call in this container while the true cost is ~0.55 ms/call — an unrelated no-op loop shows the same multi-hundred-ms stalls, so a mean against a wall-clock bound is a flaky test, not a regression detector. The median of several batches ignores a stalled batch and still fails loudly if the marker pre-check is removed, since the split+join path costs ~31 ms/call.
test('extractSpillNotices: a body with no pointer is returned unchanged, and cheaply', async () => {
	const {extractSpillNotices} = await import('../mods/rtk.ts');
	const plain = Array.from({length: 20_000}, (_, index) => `[build] compiling module ${index} ...`).join('\n');
	const result = extractSpillNotices(plain);
	assert.equal(result.body, plain, 'the body is byte-identical');
	assert.equal(result.notices, '', 'and nothing was lifted');
	assert.equal(extractSpillNotices('no newline at all').body, 'no newline at all');
	const batches: number[] = [];
	for (let batch = 0; batch < 5; batch += 1) {
		const started = performance.now();
		for (let index = 0; index < 20; index += 1) extractSpillNotices(plain);
		batches.push((performance.now() - started) / 20);
	}
	batches.sort((a, b) => a - b);
	assert.ok(batches[2]! < 5, `a 700 KB body costs almost nothing (median ${batches[2]!.toFixed(2)} ms/call)`);
});

// Rules: the same mid-result pointer arrives on a grep result, and `condense` is shared — this pins that the grep path goes through it rather than around it.
test('the spill pointer survives a condensed grep result too', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const truncation = '[... output truncated: 900000 chars total, showing first 12000 and last part ...]';
	const pointer = '[full output saved to: /tmp/x.log — read it with read_file (offset/limit) or grep]';
	const lines = Array.from({length: 250}, (_, index) => `src/a${index % 5}.ts:${index + 1}:  const value = compute(input);`);
	lines.splice(120, 0, truncation, pointer);
	const input = `Found 250 files\n${lines.join('\n')}`;
	const out = resultText(await firstHook(fake).afterToolCall?.({toolName: 'grep', result: [{type: 'text', text: input}], isError: false}));
	assert.ok(out.includes(pointer), 'the pointer survived the grep path');
	assert.ok(out.startsWith('Found 250 files\n'), 'and the count is still the first line');
	assert.ok(out.length < input.length, 'and the body shrank');
});

/* ------------------------------------------------------------ fidelity guard */

// Rules: `never_worse` only checks byte size. Measured against the real binary, a cargo failure of 20 `error[E0xx]` lines (1,919 bytes) came back as 156 bytes of grep grouping — `20 matches in 1F: [file] --> src/lib.rs (20): 0: 5 …` — with every error message gone and no recovery hint. The guard recognises a scan that grouped non-match output and keeps the original.
test('a build failure rtk mis-groups as grep output keeps its error messages', async t => {
	if (!hasRtk()) return t.skip('rtk is not installed here');
	const fake = await loaded();
	const cargo = Array.from({length: 20}, (_, index) =>
		`error[E0${index}]: cannot find value \`x${index}\` in this scope\n  --> src/lib.rs:${index}:5`,
	).join('\n') + '\n' + Array.from({length: 200}, (_, index) => `  note ${index}`).join('\n');
	const input = `Exit code: 1\n${cargo}`;
	const result = await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false});
	// The guard refuses the filter, and with no colour to strip the result is byte-identical, so the hook leaves it alone.
	assert.equal(result, undefined, 'the original reaches the model unchanged');
});

// Rules: the guard must not reject a genuine grouping — a real path list grouped by the find filter is the documented win, and refusing it would turn the filter off for the shape it exists for.
test('the fidelity guard separates a real grouping from a misdetected one', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const rows = Array.from({length: 40}, (_, index) => `src/a${index % 4}.ts:${index + 1}:  const x = compute();`).join('\n');
	const grouped = '40 matches in 4 files:\n\nsrc/a0.ts (10):\n     1: const x = compute();';
	assert.equal(checkFidelity(rows, grouped, true).ok, true, 'a match list grouped is correct');

	const paths = Array.from({length: 40}, (_, index) => `./src/d${index % 4}/f${index}.ts`).join('\n');
	assert.equal(checkFidelity(paths, '40 files in 4 dirs:\n./src/d0/ (10)\n  +6', true).ok, true, 'a path list grouped is correct');

	const build = ['error[E0308]: mismatched types', '  --> src/lib.rs:5:9', ...Array.from({length: 30}, (_, index) => `  note ${index}`)].join('\n');
	const misdetected = checkFidelity(build, '31 matches in 1 files:\n\n[file]   --> src/lib.rs (31):\n     0: 9', true);
	assert.equal(misdetected.ok, false, 'a build log grouped as matches is refused');
	assert.match(misdetected.lost[0] ?? '', /format:/);

	// Rules: the pipe filter's grouping is the other spelling — `NF:` over `[file]` blocks — and it is the shape the measured twenty-error misgroup came back in, so both spellings are pinned.
	const abbreviated = checkFidelity(build, '31 matches in 1F:\n\n[file]   --> src/lib.rs (31):\n     0: 9', true);
	assert.equal(abbreviated.ok, false, 'the abbreviated NF: header is recognised as grouping too');
	assert.match(abbreviated.lost[0] ?? '', /format:/);
});

// Rules: a grouped result is only suspicious when rtk auto-detected it. A grep or find result is filtered with its own explicit filter, so its grouping is never second-guessed.
test('the guard only second-guesses an auto-detected filter', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const build = ['error[E0308]: mismatched types', ...Array.from({length: 30}, (_, index) => `  note ${index}`)].join('\n');
	const grouped = '31 matches in 1 files:\n\n[file]   --> src/lib.rs (31):\n     0: 9';
	assert.equal(checkFidelity(build, grouped, false).ok, true, 'an explicit filter result is accepted');
	assert.equal(checkFidelity(build, grouped, true).ok, false, 'the same result auto-detected is refused');
});

// Rules: losing a negation inverts meaning, which is the DeepShrink thesis this guard borrows — no legitimate summariser drops one, so it is refused on every path.
test('a filter that drops a negation is refused', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const original = 'Do not run this command. Never delete the cache.';
	assert.equal(checkFidelity(original, 'Do not run this command. Never delete the cache.', false).ok, true);
	const report = checkFidelity(original, 'Do run this command. Delete the cache.', false);
	assert.equal(report.ok, false);
	assert.match(report.lost[0] ?? '', /negation/);
});

// Rules: rtk's grep/find grouping elides repeated rows by design (`+N`), so the negation COUNT legitimately falls. Measured against rtk 1.1.0: a real grouped grep of `returns not ready_N` rows went 41,739 -> 11,252 bytes and the counting test refused it (`negation: 200 -> 80`), which turned the filter off for every search whose matches contain `not`. A grouped result keeps a reduced count, so the count test is skipped there.
test('a grouped result is not refused for eliding repeated negations', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const rows = Array.from({length: 300}, (_, index) => `src/a.ts:${index + 1}:  if (!ready) return; // not allowed`).join('\n');
	const grouped = '300 matches in 1F:\n\n[file] src/a.ts (300):\n     1: if (!ready) return; // not allowed\n  +290';
	assert.equal(checkFidelity(rows, grouped, false).ok, true, 'elided rows carry a reduced negation count, which is expected');
	assert.equal(checkFidelity(rows, grouped, true).ok, true, 'the auto-detected path is the same');
});

// Rules: total negation loss still inverts meaning even when grouped, so the grouping exemption must not become a hole for the original failure.
test('a grouped result that drops every negation is still refused', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const rows = Array.from({length: 40}, (_, index) => `src/a.ts:${index + 1}:  not ready`).join('\n');
	const grouped = '40 matches in 1F:\n\n[file] src/a.ts (40):\n     1: fine';
	const report = checkFidelity(rows, grouped, false);
	assert.equal(report.ok, false);
	assert.match(report.lost.join(' '), /negation: 40 -> 0/);
});

// Rules: the mod's OWN local condenser emits the abbreviated `NF:` header, so the grouping exemption has to recognise it or the two disagree. Measured before this was fixed: a 12-row single-file body whose rows all said `not` condensed 80% but the fidelity guard refused it (`negation: 12 -> 1`), so the local pass quietly did nothing on any search whose matched code contains a negation. Both layouts are pinned, because `layoutByDir` emits `NF:` and `layoutByFile` emits `[file]`.
test('the fidelity guard accepts the local condenser\'s own two layouts', async () => {
	const {condenseGrepRows, checkFidelity} = await import('../mods/rtk.ts');
	const single = Array.from({length: 12}, (_, index) => `src/a.ts:${index + 1}:  return not ready;`).join('\n');
	const fileLayout = condenseGrepRows(single);
	assert.ok(fileLayout?.startsWith('12 matches in 1F:'), 'the file layout uses the abbreviated header');
	assert.equal(checkFidelity(single, fileLayout ?? '', false).ok, true, 'and its elision is not mistaken for a lost negation');

	const scattered = Array.from({length: 60}, (_, index) => `./src/d${index % 12}/f${index}.ts:${index + 1}:  return not ready_${index};`).join('\n');
	const dirLayout = condenseGrepRows(scattered);
	assert.ok(dirLayout?.startsWith('60 matches in 60F:'), 'the directory layout uses it too');
	assert.equal(checkFidelity(scattered, dirLayout ?? '', false).ok, true, 'the directory layout is accepted as well');
});

// Rules: the host's `grep` tool supports `-A/-B/-C`, and ripgrep prints a context line as `path-line-text` where a match is `path:line:text`. rtk's grep filter keeps only the match form, so the context the caller explicitly asked for is dropped — measured end-to-end through the real mod, a 40-match result with 40 context lines went 3,178 -> 1,665 bytes with all 40 gone. The explicit-filter path skips the grouping test, so this needs its own check.
test('a grep result carrying -A/-B/-C context is not handed to the grep filter', async () => {
	const {checkFidelity} = await import('../mods/rtk.ts');
	const paths = Array.from({length: 40}, (_, index) => `src/f${index % 4}.ts`);
	const withContext = paths.map((path, index) => `src/f${index % 4}.ts:${index + 1}:  const hit${index} = f();\nsrc/f${index % 4}.ts-${index + 2}-  context${index}`).join('\n');
	const grouped = '40 matches in 4F:\n\n[file] src/f0.ts (10):\n    10: const hit0 = f();';
	const report = checkFidelity(withContext, grouped, false);
	assert.equal(report.ok, false, 'the explicit grep/open filter is refused when context rows would be lost');
	assert.match(report.lost.join(' '), /context/);

	const bareRows = paths.map((_, index) => `src/f${index % 4}.ts:${index + 1}:  const hit${index} = f();`).join('\n');
	assert.equal(checkFidelity(bareRows, grouped, false).ok, true, 'a context-free match list is still accepted');
});

// Rules: a path may itself contain `-<digits>-`, so a delimiter-only test reads `src/v2-feat-12-bar1.ts` as a context row and refuses a legitimate find-mode grouping (measured: a 40-path list was refused). The context path must be one the match rows already named.
// Rules: the mixed case is the one that discriminates — real match rows present (so the early return cannot mask the bug) plus a path-shaped line that is not their context. A paths-only list exits before the delimiter test ever runs.
test('a path containing -N- is not mistaken for grep context', async () => {
	const {hasGrepContext, checkFidelity} = await import('../mods/rtk.ts');
	const paths = Array.from({length: 40}, (_, index) => `src/v2-feat-12-bar${index}.ts`);
	assert.equal(hasGrepContext(paths.join('\n')), false, 'a plain path list carries no context');
	assert.equal(checkFidelity(paths.join('\n'), '40 files in 2 dirs:\n\n  src/  (40)', false).ok, true, 'and its grouping is accepted');

	const rows = Array.from({length: 40}, (_, index) => `src/a.ts:${index + 1}:  hit${index}`).join('\n');
	const withContext = Array.from({length: 40}, (_, index) => `src/a.ts:${index + 1}:  hit${index}\nsrc/a.ts-${index + 2}-  ctx${index}`).join('\n');
	assert.equal(hasGrepContext(rows), false, 'match rows alone are not context');
	assert.equal(hasGrepContext(withContext), true, 'a known path with a -N- delimiter is context');

	const mixed = `${rows}\nsrc/v2-feat-12-bar1.ts\nnotes-for-2024-summary.ts`;
	assert.equal(hasGrepContext(mixed), false, 'unrelated path-shaped lines are not context for a known match path');
});

/* ------------------------------------ consecutive notices, windows rows, never-worse */

// Rules: `formatResult2` appends the cwd note and THEN the PowerShell edition banner, so a shell result can end with two consecutive notice lines. Only the last one was split off, and rtk folded the earlier one away with the body — measured: in=2209 out=2059, cwd note kept=false, edition kept=true. Losing the cwd note can leave the model thinking the next command runs in the project root.
test('splitSegments: every consecutive host notice is split off, not only the last', () => {
	const cwd = '[cwd change to /tmp scanned: next call starts from the project directory]';
	const banner = '[PowerShell edition: Windows PowerShell 5.1]';
	const split = splitSegments('shell_command', `Exit code: 1\nbody line\n${cwd}\n${banner}`);
	assert.equal(split.head, 'Exit code: 1\n');
	assert.equal(split.body, 'body line', 'neither notice reaches the filtered body');
	assert.equal(split.tail, `\n${cwd}\n${banner}`, 'both notices are re-attached in order');
});

// Rules: ripgrep on Windows prints `C:\src\a.ts:12:text`; the old row pattern stopped at the drive colon, so the context-loss guard never fired and rtk's grep filter could drop every `path-line-text` context line. The drive prefix is optional so POSIX rows are unchanged.
test('grep rows: Windows drive-letter paths are recognised, so context loss is refused', () => {
	const rows = [
		'C:\\src\\a.ts:12: hit',
		'C:\\src\\a.ts:13: hit',
		'C:\\src\\a.ts-14- ctx',
	].join('\n');
	assert.equal(isGrepRows(rows), true, 'a drive-letter match row is a grep row');
	assert.equal(hasGrepContext(rows), true, 'its -N- context line is recognised');
	const grouped = '3 matches in 1F:\n\n[file] C:\\src\\a.ts (3):\n 12: hit';
	const report = checkFidelity(rows, grouped, false);
	assert.equal(report.ok, false, 'the explicit grep filter is refused when context would be lost');
	assert.match(report.lost.join(' '), /context/);
});

// Rules: the fidelity guard's path-list test required a forward slash, so a Windows path list grouped by the find filter was refused as a wrong format guess and the 73% glob win never applied there.
test('fidelity: a Windows path list grouped by the find filter is accepted', () => {
	const paths = ['C:\\src\\a.ts', 'C:\\src\\b.ts'].join('\n');
	assert.equal(checkFidelity(paths, '2 files in 1 dirs:\n\nC:\\src\\ (2)', true).ok, true);
});

// Rules: rtk only promises the filtered body is smaller, not the reassembled result. With two mid-result spill notices moved to the end, the re-attached newline can make the result one byte larger than the original. The mod promises never-worse, so the original must win.
test('condense: a filtered result that would be larger than the original is rejected', async () => {
	const exec = async (request: ExecRequest) => {
		if (request.args?.[0] === '--version') return {stdout: 'rtk 1.1.0', stderr: '', code: 0};
		const tail = request.args?.at(-1) ?? '';
		const script = process.platform === 'win32' ? readFileSync(tail, 'utf8') : tail;
		const file = /< "([^"]+)"/.exec(script)?.[1];
		const body = file ? readFileSync(file, 'utf8') : '';
		return {stdout: body.slice(0, -1), stderr: '', code: 0};
	};
	const fake = createFakeCmd({exec, flags: {'rtk-bin': process.execPath}});
	fake.cmd.name = 'probe';
	rtk(fake.cmd as never);
	firstHook(fake).onSessionStart?.();
	await new Promise(resolve => setTimeout(resolve, 50));
	runHandler(fake.commands, 'rtk', 'on');

	const truncation = '[... output truncated: 900000 chars total, showing first 12000 and last part ...]';
	const pointer = '[full output saved to: /tmp/x.log — read it with read_file (offset/limit) or grep]';
	const body = [
		'test result: FAILED. 1 failed',
		truncation,
		pointer,
		...Array.from({length: 60}, (_, index) => `note line ${index} that a filter folds away`),
	].join('\n');
	const input = `Exit code: 1\n${body}`;
	const result = await firstHook(fake).afterToolCall?.({toolName: 'shell_command', result: [{type: 'text', text: input}], isError: false});
	if (result !== undefined) {
		assert.ok(resultText(result).length <= input.length, 'a filter may never return a larger result');
	}
	assert.equal(result, undefined, 'the original is smaller, so it is the only valid answer');
});

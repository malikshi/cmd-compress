// rtk-shapes.test.ts — the tool-output shapes rtk is fed, end to end against the real binary.
// exports: none (node:test)
// used_by: npm test
// related: mods/rtk.ts
// rules: Command Code's own tool output is not rtk's fixture — grep and glob wrap their body in a header or a trailer, and shell_command prefixes an exit status. A filter that folds those away deletes information the model needs, so each shape is pinned here against the installed rtk.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import rtk, {canRefilterCompressed, isGrepRows, splitSegments, MIN_FILTER_BYTES} from '../mods/rtk.ts';
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

// Rules: a diff, a git log, and a build log all contain colons and digits, so the row test must not fire on them — re-filtering a format rtk did not decline was measured as byte-identical (0 bytes, 12 real commands), which is a wasted process rather than a loss, but still not worth spawning.
test('output that is not a match list is never re-filtered', () => {
	const samples: Array<[string, string]> = [
		['diff', '+++ b/mods/rtk.ts\n--- a/mods/rtk.ts\n@@ -1,4 +1,4 @@\n-const a = 1;\n+const a = 2;'],
		['git log', 'f7e35e0 chore: release 0.1.1\nd18dfed fix(rtk): stop deleting host envelopes'],
		['build log', '> tsc --noEmit\n\nsrc/a.ts(12,5): error TS2322: Type string is not assignable'],
		['json', '{\n  "name": "cmd-compress",\n  "version": "0.1.1"\n}'],
	];
	for (const [name, text] of samples) {
		assert.equal(canRefilterCompressed(text), false, `${name} must not be re-filtered`);
	}
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

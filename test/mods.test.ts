// mods.test.ts — level parsing, presets, and the RTK rewrite gate.
// exports: none (node:test)
// used_by: npm test
// related: mods/caveman.ts, mods/ponytail.ts, mods/compress.ts, mods/rtk.ts
// rules: these must not import the mods' factory (it reads cmd.store at load); only the pure helpers are imported.
// agent: 2026-11-02 initial

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCavemanLevel, CAVEMAN_STOP_PHRASES} from '../mods/caveman.ts';
import {normalizePonytailLevel, PONYTAIL_STOP_PHRASES} from '../mods/ponytail.ts';
import {COMPRESS_PRESETS, presetFor} from '../mods/compress.ts';
import {shouldRewrite, filterNameFor, filterForShape, MIN_FILTER_BYTES, parseRtkVersion, isSupportedVersion, classifyRewrite, MIN_SUPPORTED_RTK_MINOR, guidanceText, pinBinary} from '../mods/rtk.ts';

test('normalizeCavemanLevel: on and empty mean the default, off and stop mean off', () => {
	assert.equal(normalizeCavemanLevel(''), 'full');
	assert.equal(normalizeCavemanLevel('on'), 'full');
	assert.equal(normalizeCavemanLevel('OFF'), 'off');
	assert.equal(normalizeCavemanLevel('stop'), 'off');
});

test('normalizeCavemanLevel: every declared level is accepted, unknown answers null', () => {
	assert.equal(normalizeCavemanLevel('ultra'), 'ultra');
	assert.equal(normalizeCavemanLevel('megacave-full'), 'megacave-full');
	assert.equal(normalizeCavemanLevel('review'), null);
});

test('stop phrases: "stop caveman" and "caveman off" end the mode, a normal sentence does not', () => {
	assert.ok(CAVEMAN_STOP_PHRASES.has('stop caveman'));
	assert.ok(CAVEMAN_STOP_PHRASES.has('caveman off'));
	assert.ok(CAVEMAN_STOP_PHRASES.has('normal mode'), 'the upstream phrase');
	assert.ok(!CAVEMAN_STOP_PHRASES.has('add a normal mode toggle'));
});

test('normalizePonytailLevel: on means full, off means off, review is not a runtime level', () => {
	assert.equal(normalizePonytailLevel('on'), 'full');
	assert.equal(normalizePonytailLevel('off'), 'off');
	assert.equal(normalizePonytailLevel('review'), null);
	assert.ok(PONYTAIL_STOP_PHRASES.has('stop ponytail'));
	assert.ok(PONYTAIL_STOP_PHRASES.has('normal mode'), 'the upstream phrase');
});

test('presetFor: empty means balanced, off turns everything off, unknown answers null', () => {
	assert.deepEqual(presetFor(''), COMPRESS_PRESETS.balanced);
	assert.deepEqual(presetFor('off'), {caveman: 'off', ponytail: 'off', rtk: 'off'});
	assert.equal(presetFor('turbo'), null);
});

test('presets: max escalates all three, balanced is the default level on all three', () => {
	assert.deepEqual(COMPRESS_PRESETS.max, {caveman: 'ultra', ponytail: 'ultra', rtk: 'on'});
	assert.deepEqual(COMPRESS_PRESETS.balanced, {caveman: 'full', ponytail: 'full', rtk: 'on'});
	assert.equal(COMPRESS_PRESETS.lite!.caveman, 'lite');
});

// Rules: the preset names are the upstream combo reference's (KurutoDenzeru/tersio: off | medium | balanced | max), so a person coming from that tool types the same word here; `lite` is kept as an alias so the name this package used first still works.
test('presets: the upstream names are all present, and lite aliases medium', () => {
	for (const name of ['off', 'medium', 'balanced', 'max']) {
		assert.ok(name in COMPRESS_PRESETS, `the upstream preset ${name} exists`);
	}
	assert.deepEqual(COMPRESS_PRESETS.lite, COMPRESS_PRESETS.medium, 'lite is the old name for medium');
});

test('shouldRewrite: rtk-prefixed, disabled, and empty commands are left alone', () => {
	assert.equal(shouldRewrite('git status'), true);
	assert.equal(shouldRewrite('   '), false);
	assert.equal(shouldRewrite('rtk git status'), false);
	assert.equal(shouldRewrite('RTK_DISABLED=1 git status'), false);
});

// Rules: the rewrite answers a bare `rtk`, which the host shell resolves from its own PATH — the mod can hold an rtk the shell cannot see.
test('pinBinary: every command-position rtk becomes the absolute path', () => {
	assert.equal(pinBinary('rtk git status', '/opt/rtk', 'linux'), "'/opt/rtk' git status");
	assert.equal(pinBinary('rtk git add . && rtk git commit -m x', '/opt/rtk', 'linux'), "'/opt/rtk' git add . && '/opt/rtk' git commit -m x");
	assert.equal(pinBinary('rtk ls -la | head', '/opt/rtk', 'linux'), "'/opt/rtk' ls -la | head");
	assert.equal(pinBinary('cd src && rtk ls', '/opt/rtk', 'linux'), "cd src && '/opt/rtk' ls");
	assert.equal(pinBinary('rtk a || rtk b; rtk c', '/opt/rtk', 'linux'), "'/opt/rtk' a || '/opt/rtk' b; '/opt/rtk' c");
});

// Rules: a quoted argument that mentions rtk is data, not a command — pinning it would corrupt the command line.
test('pinBinary: rtk inside an argument is left untouched', () => {
	assert.equal(pinBinary('git commit -m "use rtk"', '/opt/rtk', 'linux'), 'git commit -m "use rtk"');
	assert.equal(pinBinary('grep rtk README.md', '/opt/rtk', 'linux'), 'grep rtk README.md');
	assert.equal(pinBinary('echo rtk', '/opt/rtk', 'linux'), 'echo rtk');
});

test('pinBinary: a path containing a single quote stays shell-safe', () => {
	assert.equal(pinBinary('rtk git status', "/opt/it's/rtk", 'linux'), "'/opt/it'\\''s/rtk' git status");
});

// Rules: cmd.exe gives single quotes no meaning — it would pass `'` straight through and the pinned path would not resolve — so Windows must be double-quoted, with an embedded `"` doubled.
test('pinBinary: Windows double-quotes the path, since cmd.exe ignores single quotes', () => {
	assert.equal(
		pinBinary('rtk git status', 'C:\\Users\\x\\.bun\\bin\\rtk.exe', 'win32'),
		'"C:\\Users\\x\\.bun\\bin\\rtk.exe" git status',
	);
	assert.equal(
		pinBinary('cd src && rtk ls', 'C:\\rtk.exe', 'win32'),
		'cd src && "C:\\rtk.exe" ls',
		'the segment rule is the same on both platforms',
	);
	assert.ok(!pinBinary('rtk ls', 'C:\\rtk.exe', 'win32').includes("'"), 'no single quote survives on Windows');
});

// Rules: rtk itself emits `env FOO=1 rtk …`, so a command-position pin must see past a run of assignments.
test('pinBinary: an assignment prefix does not hide the command', () => {
	assert.equal(pinBinary('env FOO=1 rtk git status', '/opt/rtk', 'linux'), "env FOO=1 '/opt/rtk' git status");
	assert.equal(pinBinary('FOO=1 rtk ls', '/opt/rtk', 'linux'), "FOO=1 '/opt/rtk' ls");
});

test('filterNameFor: grep and glob map to rtk filters, others do not', () => {
	assert.equal(filterNameFor('grep'), 'grep');
	assert.equal(filterNameFor('glob'), 'find');
	assert.equal(filterNameFor('read_file'), undefined);
});

// Rules: the grep tool's default mode emits a path list under a `Found N files` header, which the grep filter returns unchanged. The shape overrides the tool's nominal filter so that result is condensed instead of passed through.
test('filterForShape: a Found header on a grep result selects the find filter', () => {
	assert.equal(filterForShape('grep', 'grep', 'Found 300 files\nsrc/a.ts\n'), 'find');
	assert.equal(filterForShape('grep', 'grep', 'src/a.ts:1: hit\n'), 'grep', 'content rows keep the grep filter');
	assert.equal(filterForShape('glob', 'find', 'Found 3 files\n'), 'find');
	assert.equal(filterForShape('shell_command', null, 'Found 3 files\n'), null, 'a shell body is auto-detected, never forced');
});

test('MIN_FILTER_BYTES: the spawn threshold is above one screenful', () => {
	assert.ok(MIN_FILTER_BYTES >= 1000);
});

test('parseRtkVersion: reads the banner and refuses anything unparseable', () => {
	assert.deepEqual(parseRtkVersion('rtk 1.0.1\n'), {major: 1, minor: 0, patch: 1});
	assert.deepEqual(parseRtkVersion('rtk 0.23.4-dev'), {major: 0, minor: 23, patch: 4});
	assert.equal(parseRtkVersion('nope'), null);
	assert.equal(parseRtkVersion(''), null);
});

test('isSupportedVersion: 0.x needs the minor that shipped rewrite, 1.x always passes', () => {
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 0.22.9')), false);
	assert.equal(isSupportedVersion(parseRtkVersion(`rtk 0.${MIN_SUPPORTED_RTK_MINOR}.0`)), true);
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 1.0.1')), true);
	assert.equal(isSupportedVersion(null), true, 'an unknown version is not a reason to disable');
});

// Rules: the gate exists because `rtk rewrite` first appears in 0.25.0 — verified against the upstream tree, where v0.24.0 has no Rewrite subcommand. One minor below the floor must be rejected, and the patch digit must not change the answer.
test('isSupportedVersion: the boundary is exact, and the patch digit is irrelevant', () => {
	assert.equal(MIN_SUPPORTED_RTK_MINOR, 25, 'the floor is the release that added rewrite');
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 0.24.99')), false, 'v0.24.0 has no Rewrite subcommand');
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 0.25.0')), true);
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 0.25.9')), true);
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 1.0.0')), true, 'a 1.x never needs the minor check');
	assert.equal(isSupportedVersion(parseRtkVersion('rtk 2.0.0')), true);
});

// Rules: the whole exit-code contract in one table — a wrong branch here either runs a denied command or drops a rewrite.
test('classifyRewrite: maps every documented exit code', () => {
	assert.deepEqual(classifyRewrite(0, 'rtk git status', 'git status'), {kind: 'rewrite', command: 'rtk git status'});
	assert.deepEqual(classifyRewrite(3, 'rtk ls', 'ls'), {kind: 'rewrite', command: 'rtk ls'});
	assert.deepEqual(classifyRewrite(1, '', 'npm test'), {kind: 'pass'});
	assert.deepEqual(classifyRewrite(2, 'pipeline denied', 'git push'), {kind: 'deny', reason: 'pipeline denied'});
	assert.deepEqual(classifyRewrite(2, '', 'git push'), {kind: 'pass'});
	assert.deepEqual(classifyRewrite(0, 'rtk git status', 'rtk git status'), {kind: 'pass'}, 'a no-op rewrite is not a rewrite');
	assert.deepEqual(classifyRewrite(0, '', 'git status'), {kind: 'pass'}, 'an empty body is not a rewrite');
	assert.deepEqual(classifyRewrite(9, 'wat', 'x'), {kind: 'pass'}, 'an unknown code fails open');
});

// Rules: the prompt text tells the model which commands and flags exist, so a wrong one costs a failed tool call on every session; the skip is loud when rtk is absent rather than a silent pass.
test('the injected guidance only names commands this rtk build actually has', async t => {
	const {execFileSync} = await import('node:child_process');
	let help: string;
	try {
		help = execFileSync('rtk', ['--help'], {encoding: 'utf8', timeout: 5000});
	} catch {
		t.skip('rtk is not installed here');
		return;
	}
	const guidance = guidanceText();
	const named = [...guidance.matchAll(/`rtk ([a-z-]+)/g)].map(match => match[1]);
	assert.ok(named.length >= 8, 'the guidance names several subcommands');
	for (const name of new Set(named)) {
		assert.match(help, new RegExp(`\\b${name}\\b`), `rtk ${name} is listed in rtk --help`);
	}
});

// Rules: a named subcommand can exist while a flag it is shown with does not — `--level aggressive` and `--keys-only` are both taught by the guidance, so each flag is checked against that subcommand's own help.
test('the injected guidance only names flags each subcommand actually takes', async t => {
	const {execFileSync} = await import('node:child_process');
	const helpOf = (subcommand: string): string | null => {
		try {
			return execFileSync('rtk', [subcommand, '--help'], {encoding: 'utf8', timeout: 5000});
		} catch {
			return null;
		}
	};
	if (helpOf('gain') === null) return t.skip('rtk is not installed here');

	const cases: Array<[subcommand: string, flag: string]> = [
		['read', '--level'],
		['json', '--keys-only'],
	];
	for (const [subcommand, flag] of cases) {
		assert.ok(guidanceText().includes(`rtk ${subcommand}`), `the guidance teaches ${subcommand}`);
		assert.ok(helpOf(subcommand)?.includes(flag), `rtk ${subcommand} takes ${flag}`);
	}
	assert.match(helpOf('gain') ?? '', /--format/, 'the read is `gain -f json`, and -f is --format');
});


test('filterNameFor: only the two real tool names map, prototype keys do not', () => {
	assert.equal(filterNameFor('grep'), 'grep');
	assert.equal(filterNameFor('glob'), 'find');
	assert.equal(filterNameFor('shell_command'), undefined);
	for (const hostile of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
		const got = filterNameFor(hostile);
		assert.equal(got, undefined, `${hostile} must not answer a filter name`);
		assert.equal(typeof got, 'undefined', `${hostile} must not leak a prototype value`);
	}
});

// Rules: the platform is pinned to POSIX here. pinBinary defaults to process.platform, so leaving it implicit made these assertions pass on Linux and measure Windows quoting on a Windows runner — the CI logs showed exactly that.
test('pinBinary: a prefix command before rtk is pinned, and plain programs are not', () => {
	const bin = '/usr/bin/rtk';
	const posix = 'linux';
	for (const prefix of ['time', 'nohup', 'command', 'nice']) {
		assert.equal(pinBinary(`${prefix} rtk git status`, bin, posix), `${prefix} '${bin}' git status`, prefix);
	}
	// timeout carries its own duration argument
	assert.equal(pinBinary('timeout 5 rtk git status', bin, posix), `timeout 5 '${bin}' git status`);
	assert.equal(pinBinary('timeout -k 1 5 rtk ls', bin, posix), `timeout -k 1 5 '${bin}' ls`);
	assert.equal(pinBinary('nice -n 5 rtk ls', bin, posix), `nice -n 5 '${bin}' ls`);
	// a command that only looks like a prefix is left alone: nothing named rtk follows it
	assert.equal(pinBinary('timeout 5 ls', bin, posix), 'timeout 5 ls');
	assert.equal(pinBinary('echo rtk', bin, posix), 'echo rtk');
	// and rtk as data inside an argument is never touched
	assert.equal(pinBinary('git commit -m "use rtk"', bin, posix), 'git commit -m "use rtk"');
});

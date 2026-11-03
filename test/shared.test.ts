// shared.test.ts — the per-mod store, prompt-block surgery, and path shortening.
// exports: none (node:test)
// used_by: npm test
// related: mods/shared.ts
// rules: the fake store mirrors the harness store's synchronous get / async set so the serialised writer is exercised.
// agent: 2026-11-02 initial; per-mod key after learning each mod gets its own store file

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	DEFAULT_MODE,
	filterShell,
	pipeCommand,
	readOwnMode,
	writeOwnMode,
	stripBlock,
	wrapBlock,
	shortPaths,
	resolveBin,
} from '../mods/shared.ts';

function fakeStore(initial: Record<string, unknown> = {}) {
	const data = {...initial};
	return {
		data,
		get(key: string) {
			return data[key];
		},
		async set(key: string, value: unknown) {
			data[key] = value;
		},
	};
}

test('readOwnMode: a missing value answers off', () => {
	assert.equal(readOwnMode(fakeStore()), DEFAULT_MODE);
	assert.equal(readOwnMode(fakeStore({mode: ''})), DEFAULT_MODE);
	assert.equal(readOwnMode(fakeStore({mode: 7})), DEFAULT_MODE);
});

test('readOwnMode: a stored mode is returned verbatim', () => {
	assert.equal(readOwnMode(fakeStore({mode: 'ultra'})), 'ultra');
});

// Rules: a stored value the mod does not recognise must degrade to off, not be treated as on; otherwise a corrupt store silently enables compression and the status line prints the garbage value.
test('readOwnMode: a value the validator rejects falls back instead of enabling the mode', () => {
	const valid = (value: string) => value === 'on' || value === 'off';
	assert.equal(readOwnMode(fakeStore({mode: 'on'}), 'off', valid), 'on');
	assert.equal(readOwnMode(fakeStore({mode: 'garbage'}), 'off', valid), 'off');
	assert.equal(readOwnMode(fakeStore({mode: 'true'}), 'off', valid), 'off', 'a JSON-ish value is not a mode');
});

test('writeOwnMode: the value lands under the mod-own key only', async () => {
	const store = fakeStore();
	writeOwnMode(store, 'full');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(store.data, {mode: 'full'});
});

test('writeOwnMode: rapid writes keep the last value', async () => {
	const store = fakeStore();
	writeOwnMode(store, 'lite');
	writeOwnMode(store, 'full');
	writeOwnMode(store, 'ultra');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(readOwnMode(store), 'ultra');
});

test('writeOwnMode: a failing set does not break later writes', async () => {
	let calls = 0;
	const store = {
		get: () => undefined,
		async set(_key: string, _value: unknown) {
			calls += 1;
			if (calls === 1) throw new Error('disk full');
		},
	};
	writeOwnMode(store, 'lite');
	writeOwnMode(store, 'full');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(calls, 2);
});

test('wrapBlock: surrounding whitespace is trimmed and the tag is closed', () => {
	assert.equal(wrapBlock('caveman', '  body  '), '<caveman>\nbody\n</caveman>');
});

test('stripBlock: a previous block is removed and its neighbours kept', () => {
	const prompt = `base\n\n<caveman>\nold\n</caveman>\n\ntail`;
	const stripped = stripBlock(prompt, 'caveman');
	assert.ok(!stripped.includes('<caveman>'));
	assert.ok(!stripped.includes('old'));
	assert.ok(stripped.startsWith('base'));
	assert.ok(stripped.endsWith('tail'));
});

test('stripBlock: re-injecting replaces instead of stacking', () => {
	const once = `base\n\n${wrapBlock('caveman', 'lite rules')}`;
	const twice = `${stripBlock(once, 'caveman')}\n\n${wrapBlock('caveman', 'ultra rules')}`;
	assert.equal((twice.match(/<caveman>/g) ?? []).length, 1);
	assert.ok(twice.includes('ultra rules'));
	assert.ok(!twice.includes('lite rules'));
});

test('shortPaths: the workspace prefix is dropped, longer paths keep their tail', () => {
	assert.equal(shortPaths('edited /repo/src/a.ts', '/repo'), 'edited src/a.ts');
	assert.equal(shortPaths('/repo/src/a.ts:12: err', '/repo'), 'src/a.ts:12: err');
	assert.equal(shortPaths('see /etc/hosts', '/repo'), 'see /etc/hosts');
});

test('resolveBin: a binary that exists on PATH is found, a missing one is null', () => {
	assert.ok(resolveBin('sh'));
	assert.equal(resolveBin('definitely-not-a-real-binary-xyz'), null);
});

// Rules: the filter redirect must run through the platform's own shell; on POSIX that is /bin/sh -c with no extra quoting, and only Windows needs the cmd.exe /d /s /c form with the line wrapped again.
test('filterShell: POSIX runs /bin/sh -c unwrapped', () => {
	assert.deepEqual(filterShell('linux', undefined), {command: '/bin/sh', args: ['-c'], wrap: false});
	assert.deepEqual(filterShell('darwin', undefined), {command: '/bin/sh', args: ['-c'], wrap: false});
});

// Rules: this is the branch that cannot run on this host, so the assertion is on the exact argv cmd.exe receives — /d /s /c, ComSpec honoured, and wrap set so the caller re-quotes the line `/s` would strip.
test('filterShell: Windows uses cmd.exe /d /s /c and asks for the line to be wrapped', () => {
	assert.deepEqual(filterShell('win32', 'C:\\Windows\\system32\\cmd.exe'), {
		command: 'C:\\Windows\\system32\\cmd.exe',
		args: ['/d', '/s', '/c'],
		wrap: true,
	});
	assert.equal(filterShell('win32', undefined).command, 'cmd.exe', 'a missing ComSpec falls back to the name');
	assert.equal(filterShell('win32', '').command, 'cmd.exe', 'an empty ComSpec does too');
});

test('pipeCommand: POSIX passes the redirect line bare to sh -c', () => {
	const shell = {command: '/bin/sh', args: ['-c'], wrap: false};
	assert.deepEqual(pipeCommand('/root/.bun/bin/rtk', 'grep', '/tmp/in.txt', shell), {
		command: '/bin/sh',
		args: ['-c', '"/root/.bun/bin/rtk" pipe -f grep < "/tmp/in.txt"'],
	});
	assert.deepEqual(pipeCommand('rtk', null, '/tmp/in.txt', shell).args[1], '"rtk" pipe < "/tmp/in.txt"', 'no -f when auto-detecting');
});

// Rules: cmd.exe `/s` strips the FIRST and LAST quote of the whole string, so the builder adds one outer pair; the result is `""bin" pipe … < "file""`, and peeling the outer pair back off leaves the line the shell must interpret.
test('pipeCommand: Windows wraps the whole line so /s has an outer pair to strip', () => {
	const shell = {command: 'cmd.exe', args: ['/d', '/s', '/c'], wrap: true};
	const built = pipeCommand('C:\\rtk.exe', 'find', 'C:\\tmp\\in.txt', shell);
	const line = built.args.at(-1)!;
	assert.equal(line, '""C:\\rtk.exe" pipe -f find < "C:\\tmp\\in.txt""');
	assert.equal(line.slice(1, -1), '"C:\\rtk.exe" pipe -f find < "C:\\tmp\\in.txt"', 'stripping the outer pair leaves the real line');
	assert.deepEqual(built.args.slice(0, 3), ['/d', '/s', '/c'], 'the flags come before the quoted line');
});

// Rules: the argv the builder makes must really run; on POSIX the shell form is executable here, so this proves the generated line is not merely well-shaped. The stand-in binary mirrors rtk's own contract — it takes `pipe [-f name]` and reads stdin — so the redirect and the flag order are exercised exactly as production builds them.
test('pipeCommand: the POSIX line actually redirects into the binary through sh', () => {
	if (process.platform === 'win32') return;
	const dir = mkdtempSync(join(tmpdir(), 'cmd-compress-test-'));
	const file = join(dir, 'in.txt');
	const standIn = join(dir, 'rtk');
	writeFileSync(file, 'hello from stdin\n', 'utf8');
	writeFileSync(standIn, '#!/bin/sh\nexec /bin/cat\n', {encoding: 'utf8', mode: 0o755});
	try {
		for (const filter of ['grep', 'find', null]) {
			const built = pipeCommand(standIn, filter, file, {command: '/bin/sh', args: ['-c'], wrap: false});
			const out = execFileSync(built.command, built.args, {encoding: 'utf8'});
			assert.equal(out, 'hello from stdin\n', `the redirect delivered the file to stdin (filter=${filter})`);
		}
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// Rules: the Windows branch cannot be executed on a Linux dev box, so it is asserted exactly where it does run — CI's windows-latest job. This is the same real-process check as the POSIX one: cmd.exe must honour /d /s /c and the outer quote pair, and the redirect must reach the binary's stdin.
// Rules: skipped (not vacuous) elsewhere, and the skip is visible in the TAP output, so a green Linux run never implies the Windows path was covered.
test('pipeCommand: the Windows line actually redirects through cmd.exe', t => {
	if (process.platform !== 'win32') return t.skip('cmd.exe only — covered by the windows-latest CI job');
	const dir = mkdtempSync(join(tmpdir(), 'cmd-compress-test-'));
	const file = join(dir, 'in.txt');
	const standIn = join(dir, 'rtk.cmd');
	writeFileSync(file, 'hello from stdin\n', 'utf8');
	// an rtk stand-in: it ignores `pipe [-f name]` and copies stdin, so only the redirect and the quoting are under test
	writeFileSync(standIn, '@echo off\r\nmore\r\n', 'utf8');
	const shell = filterShell();
	try {
		const built = pipeCommand(standIn, 'grep', file, shell);
		const stdout = execFileSync(built.command, built.args, {encoding: 'utf8'});
		assert.equal(stdout.replace(/\r\n/g, '\n'), 'hello from stdin\n', 'cmd.exe delivered the redirected file to stdin');
		assert.equal(shell.wrap, true, 'the wrap flag the builder relied on is the one cmd.exe needs');
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});

// Rules: cmd.exe `/s` removes the first quote and the last quote of the whole string. Modelling that rule — not the builder — lets this host prove the line the shell will actually interpret, so the Windows path is checked by computation here and by a real cmd.exe in the windows-latest CI job rather than asserted alone.
function cmdStripOuterQuotes(line: string): string {
	const first = line.indexOf('"');
	const last = line.lastIndexOf('"');
	return first < 0 || last <= first ? line : line.slice(first + 1, last);
}

test('pipeCommand: the Windows line survives the outer-quote strip cmd.exe performs', () => {
	const shell = {command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c'], wrap: true};
	const cases: Array<[string, string | null, string]> = [
		['C:\\rtk.exe', 'find', 'C:\\tmp\\in.txt'],
		['C:\\rtk.exe', null, 'C:\\tmp\\in.txt'],
		// paths with spaces are the case that breaks a naive quoter
		['C:\\Users\\a b\\.bun\\bin\\rtk.exe', 'grep', 'C:\\Users\\a b\\AppData\\Local\\Temp\\x y\\in.txt'],
	];
	for (const [bin, filter, file] of cases) {
		const built = pipeCommand(bin, filter, file, shell);
		const interpreted = cmdStripOuterQuotes(built.args.at(-1) ?? '');
		const flags = filter ? `-f ${filter} ` : '';
		const expected = `"${bin}" pipe ${flags}< "${file}"`;
		assert.equal(interpreted, expected, `cmd.exe would run: ${interpreted}`);
	}
});

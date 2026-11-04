// shared.test.ts — the per-mod store, prompt-block wrapping, and binary resolution.
// exports: none (node:test)
// used_by: npm test
// related: mods/shared.ts
// rules: the fake store mirrors the harness store's synchronous get / async set so the serialised writer is exercised.
// agent: unknown | unknown | 2026-11-02 | unknown | initial; per-mod key after learning each mod gets its own store file
// agent: unknown | unknown | 2026-11-03 | unknown | drop the stripBlock/shortPaths tests with the functions: the host rebuilds the append list every round, so neither had a production caller

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
	wrapBlock,
	resolveBin,
	windowsPipeScript,
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

test('resolveBin: a binary that exists on PATH is found, a missing one is null', () => {
	assert.ok(resolveBin('sh'));
	assert.equal(resolveBin('definitely-not-a-real-binary-xyz'), null);
});

// Rules: the filter redirect must run through the platform's own shell; on POSIX that is /bin/sh -c with no extra quoting, and only Windows needs the cmd.exe /d /s /c form with the line wrapped again.
test('filterShell: POSIX runs /bin/sh -c unwrapped', () => {
	assert.deepEqual(filterShell('linux', undefined), {command: '/bin/sh', args: ['-c'], wrap: false});
	assert.deepEqual(filterShell('darwin', undefined), {command: '/bin/sh', args: ['-c'], wrap: false});
});

// Rules: this is the branch that cannot run on this host, so the assertion is on the exact argv cmd.exe receives — /d /s /c, ComSpec honoured, and wrap set so the caller knows to use the batch file.
// Rules: the fallback case passes '' rather than undefined. undefined triggers the default parameter and reads the runner's real ComSpec, which made this assertion pass on Linux and compare against a real Windows path on windows-latest.
test('filterShell: Windows uses cmd.exe /d /s /c and asks for the batch-file route', () => {
	assert.deepEqual(filterShell('win32', 'C:\\Windows\\system32\\cmd.exe'), {
		command: 'C:\\Windows\\system32\\cmd.exe',
		args: ['/d', '/s', '/c'],
		wrap: true,
	});
	assert.equal(filterShell('win32', '').command, 'cmd.exe', 'an empty ComSpec falls back to the name');
});

test('pipeCommand: POSIX passes the redirect line bare to sh -c', () => {
	const shell = {command: '/bin/sh', args: ['-c'], wrap: false};
	assert.deepEqual(pipeCommand('/root/.bun/bin/rtk', 'grep', '/tmp/in.txt', shell), {
		command: '/bin/sh',
		args: ['-c', '"/root/.bun/bin/rtk" pipe -f grep < "/tmp/in.txt"'],
	});
	assert.deepEqual(pipeCommand('rtk', null, '/tmp/in.txt', shell).args[1], '"rtk" pipe < "/tmp/in.txt"', 'no -f when auto-detecting');
});

// Rules: cmd.exe re-parses its /c line and nested quotes do not survive that second pass. Measured on windows-latest: `""…rtk.cmd" pipe -f grep < "…in.txt""` was rejected with "is not recognized as an internal or external command". The builder therefore hands cmd.exe a batch file path and nothing else, and the script carries the real line.
test('pipeCommand: Windows is handed the batch file, not a re-quoted line', () => {
	const shell = {command: 'cmd.exe', args: ['/d', '/s', '/c'], wrap: true};
	const script = 'C:\\tmp\\run.cmd';
	const built = pipeCommand('C:\\rtk.exe', 'find', 'C:\\tmp\\in.txt', shell, script);
	assert.deepEqual(built.args, ['/d', '/s', '/c', script], 'only the script path reaches the command line');
	assert.doesNotMatch(built.args.at(-1) ?? '', /"".*""/, 'no nested quote pair is left for cmd.exe to re-parse');
});

// Rules: the script is where the real line lives, so its exact contents are pinned — a missing `<` or a stray quote here fails at runtime with no other signal.
test('windowsPipeScript: the batch file holds the real redirect once', () => {
	assert.equal(
		windowsPipeScript('C:\\rtk.exe', 'grep', 'C:\\tmp\\in.txt'),
		'@echo off\r\n"C:\\rtk.exe" pipe -f grep < "C:\\tmp\\in.txt"\r\n',
	);
	assert.match(windowsPipeScript('C:\\rtk.exe', null, 'C:\\tmp\\in.txt'), /pipe < /, 'no -f when auto-detecting');
	assert.match(windowsPipeScript('C:\\rtk.exe', 'find', 'C:\\a b\\in.txt'), /in\.txt"/, 'a path with a space stays quoted');
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

// Rules: the Windows branch cannot be executed on a Linux dev box, so it runs where it does — CI's windows-latest job. This is the same real-process check as the POSIX one: the batch file must run under cmd.exe and the redirect must reach the binary's stdin.
// Rules: skipped (not vacuous) elsewhere, and the skip is visible in the TAP output, so a green Linux run never implies the Windows path was covered.
test('pipeCommand: the Windows batch file actually redirects through cmd.exe', t => {
	if (process.platform !== 'win32') return t.skip('cmd.exe only — covered by the windows-latest CI job');
	const dir = mkdtempSync(join(tmpdir(), 'cmd-compress-test-'));
	const file = join(dir, 'in.txt');
	const standIn = join(dir, 'rtk.cmd');
	writeFileSync(file, 'hello from stdin\n', 'utf8');
	// an rtk stand-in: it ignores `pipe [-f name]` and copies stdin, so only the redirect is under test
	writeFileSync(standIn, '@echo off\r\nmore\r\n', 'utf8');
	const shell = filterShell();
	try {
		for (const filter of ['grep', 'find', null]) {
			const script = join(dir, 'run.cmd');
			writeFileSync(script, windowsPipeScript(standIn, filter, file), 'utf8');
			const built = pipeCommand(standIn, filter, file, shell, script);
			const stdout = execFileSync(built.command, built.args, {encoding: 'utf8'});
			assert.equal(stdout.replace(/\r\n/g, '\n'), 'hello from stdin\n', `cmd.exe delivered the redirected file to stdin (filter=${filter})`);
		}
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
});


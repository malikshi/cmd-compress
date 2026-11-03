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
import {shouldRewrite, filterNameFor, MIN_FILTER_BYTES, parseRtkVersion, isSupportedVersion, classifyRewrite, MIN_SUPPORTED_RTK_MINOR, guidanceText} from '../mods/rtk.ts';

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
	assert.ok(!CAVEMAN_STOP_PHRASES.has('add a normal mode toggle'));
});

test('normalizePonytailLevel: on means full, off means off, review is not a runtime level', () => {
	assert.equal(normalizePonytailLevel('on'), 'full');
	assert.equal(normalizePonytailLevel('off'), 'off');
	assert.equal(normalizePonytailLevel('review'), null);
	assert.ok(PONYTAIL_STOP_PHRASES.has('stop ponytail'));
});

test('presetFor: empty means balanced, off turns everything off, unknown answers null', () => {
	assert.deepEqual(presetFor(''), COMPRESS_PRESETS.balanced);
	assert.deepEqual(presetFor('off'), {caveman: 'off', ponytail: 'off', rtk: 'off'});
	assert.equal(presetFor('turbo'), null);
});

test('presets: max escalates all three, balanced is the default level on all three', () => {
	assert.deepEqual(COMPRESS_PRESETS.max, {caveman: 'ultra', ponytail: 'ultra', rtk: 'on'});
	assert.deepEqual(COMPRESS_PRESETS.balanced, {caveman: 'full', ponytail: 'full', rtk: 'on'});
	assert.equal(COMPRESS_PRESETS.lite.caveman, 'lite');
});

test('shouldRewrite: rtk-prefixed, disabled, and empty commands are left alone', () => {
	assert.equal(shouldRewrite('git status'), true);
	assert.equal(shouldRewrite('   '), false);
	assert.equal(shouldRewrite('rtk git status'), false);
	assert.equal(shouldRewrite('RTK_DISABLED=1 git status'), false);
});

test('filterNameFor: grep and glob map to rtk filters, others do not', () => {
	assert.equal(filterNameFor('grep'), 'grep');
	assert.equal(filterNameFor('glob'), 'find');
	assert.equal(filterNameFor('read_file'), undefined);
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


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
import {shouldRewrite, filterNameFor, MIN_FILTER_BYTES} from '../mods/rtk.ts';

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

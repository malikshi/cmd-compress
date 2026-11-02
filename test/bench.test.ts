// bench.test.ts — the benchmark's own logic: stats, fixtures, gates, usage parsing, and report shape.
// exports: none (node:test)
// used_by: npm test
// related: bench/lib/stats.ts, bench/lib/fixtures.ts, bench/lib/prompts.ts, bench/prompt.ts, bench/output.ts
// rules: the bench must not report a number it cannot reproduce, so each measurement helper is pinned by a test.
// agent: 2026-11-02 initial

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {estimateTokens, formatPct, median, percentile, reduction, table} from '../bench/lib/stats.ts';
import {makeGrepClustered, makeGrepScattered, makeFindOutput, REWRITE_COMMANDS} from '../bench/lib/fixtures.ts';
import {CODE_PROMPTS, PROSE_PROMPTS, checkCode, checkProse} from '../bench/lib/prompts.ts';
import {readUsage, writePromptResult} from '../bench/prompt.ts';
import {writeOutputResult} from '../bench/output.ts';

test('median: odd and even counts, and the empty case', () => {
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([]), 0);
});

test('percentile: bounds are clamped to the sample', () => {
	const values = [1, 2, 3, 4, 5];
	assert.equal(percentile(values, 0), 1);
	assert.equal(percentile(values, 50), 3);
	assert.equal(percentile(values, 100), 5);
	assert.equal(percentile([], 95), 0);
});

test('reduction: a shrink is positive, growth is negative, empty input is zero', () => {
	assert.equal(reduction(1000, 250), 0.75);
	assert.equal(reduction(100, 200), -1);
	assert.equal(reduction(0, 10), 0);
});

test('estimateTokens: chars/4 rounds up and is labelled an estimate by its callers', () => {
	assert.equal(estimateTokens('abcd'), 1);
	assert.equal(estimateTokens('abcde'), 2);
	assert.equal(estimateTokens(''), 0);
});

test('formatPct: one decimal place', () => {
	assert.equal(formatPct(0.805), '80.5%');
	assert.equal(formatPct(0), '0.0%');
});

test('table: columns align on the widest cell', () => {
	const rendered = table(['a', 'bb'], [['xxx', 'y']]);
	const [header, divider, row] = rendered.split('\n');
	assert.equal(header, 'a    bb');
	assert.equal(divider, '---  --');
	assert.equal(row, 'xxx  y');
});

test('fixtures: the same seed produces identical bytes, so two machines agree', () => {
	assert.equal(makeGrepClustered(), makeGrepClustered());
	assert.equal(makeGrepScattered(), makeGrepScattered());
	assert.equal(makeFindOutput(), makeFindOutput());
});

test('fixtures: clustered groups many hits into few files, scattered spreads them', () => {
	const clustered = makeGrepClustered();
	const clusteredFiles = new Set(clustered.split('\n').filter(Boolean).map(line => line.split(':')[0]));
	assert.equal(clusteredFiles.size, 6);
	assert.equal(clustered.split('\n').filter(Boolean).length, 240);

	const scattered = makeGrepScattered();
	const scatteredFiles = new Set(scattered.split('\n').filter(Boolean).map(line => line.split(':')[0]));
	assert.equal(scatteredFiles.size, 240);
});

test('fixtures: find output is one path per line, all distinct', () => {
	const paths = makeFindOutput().split('\n').filter(Boolean);
	assert.equal(paths.length, 260);
	assert.equal(new Set(paths).size, 260);
	assert.ok(paths.every(path => path.startsWith('./')));
});

test('fixtures: the rewrite list covers real agent commands and has no duplicates', () => {
	assert.equal(new Set(REWRITE_COMMANDS).size, REWRITE_COMMANDS.length);
	assert.ok(REWRITE_COMMANDS.includes('git status'));
	assert.ok(REWRITE_COMMANDS.length >= 12);
});

test('checkProse: every group must match, a group is an OR', () => {
	const prompt = PROSE_PROMPTS[0];
	assert.equal(checkProse('Reusing connections cuts overhead and waiting under concurrency.', prompt), true);
	assert.equal(checkProse('Connection pooling is good.', prompt), false, 'missing the overhead and concurrency groups');
});

test('checkProse: the gate is lexical and substring-based, as documented', () => {
	const prompt = PROSE_PROMPTS[1];
	// "quer" must match "queries", which a word-boundary regex would miss
	assert.equal(checkProse('An index turns a query scan into a tree lookup over rows.', prompt), true);
});

test('checkCode: every requested name must appear', () => {
	const prompt = CODE_PROMPTS[0];
	assert.equal(checkCode('function chunk() {} function chunkLazy() {}', prompt), true);
	assert.equal(checkCode('function chunk() {}', prompt), false);
});

test('readUsage: the last successful result frame wins, progress frames are ignored', () => {
	const stdout = [
		JSON.stringify({type: 'event', event: {type: 'run_start'}}),
		JSON.stringify({type: 'result', subtype: 'error', usage: {outputTokens: 999}}),
		JSON.stringify({type: 'result', subtype: 'success', usage: {inputTokens: 100, outputTokens: 7}, durationMs: 1234, finalText: 'ok'}),
	].join('\n');
	const parsed = readUsage(stdout);
	assert.ok(parsed);
	assert.equal(parsed.usage.outputTokens, 7);
	assert.equal(parsed.durationMs, 1234);
	assert.equal(parsed.finalText, 'ok');
});

test('readUsage: no result frame answers null, never a fabricated zero', () => {
	assert.equal(readUsage('not json at all'), null);
	assert.equal(readUsage('{"type":"result","subtype":"error"}'), null);
});

test('writePromptResult: a short case is labelled partial, never given a clean median', () => {
	const body = writePromptResult({
		model: 'test/model',
		runs: 3,
		measuredAt: '2026-01-01T00:00:00.000Z',
		cases: [
			{
				name: 'base',
				modes: {},
				failures: {},
				runs: [{surface: 'open', promptId: 'O1', replyTokens: 100, inputTokens: 1000, durationMs: 10, passed: true, chars: 200}],
			},
			{name: 'caveman full', modes: {caveman: 'full'}, failures: {'max-turns': 9}, runs: []},
		],
	});
	assert.match(body, /partial \(1\/9\)/);
	assert.match(body, /partial \(0\/9\)/);
	assert.match(body, /max-turns: 9/, 'a failure reason is reported, not hidden');
	assert.match(body, /This table is incomplete/);
});

test('writePromptResult: each surface gets its own table and base reference', () => {
	const body = writePromptResult({
		model: null,
		runs: 1,
		measuredAt: '2026-01-01T00:00:00.000Z',
		cases: [{name: 'base', modes: {}, failures: {}, runs: []}],
	});
	assert.match(body, /## Open prose/);
	assert.match(body, /## Pinned prose/);
	assert.match(body, /## Code/);
	assert.match(body, /Base reference: reply median 0/);
});

test('writePromptResult: delta is computed per surface, so a pinned prompt cannot mask an open one', () => {
	const run = (surface: 'open' | 'pinned', tokens: number) => ({
		surface,
		promptId: surface === 'open' ? 'O1' : 'P1',
		replyTokens: tokens,
		inputTokens: 500,
		durationMs: 5,
		passed: true,
		chars: 100,
	});
	const body = writePromptResult({
		model: null,
		runs: 1,
		measuredAt: '2026-01-01T00:00:00.000Z',
		cases: [
			{name: 'base', modes: {}, failures: {}, runs: [run('open', 100), run('pinned', 100)]},
			{name: 'caveman lite', modes: {caveman: 'lite'}, failures: {}, runs: [run('open', 60), run('pinned', 150)]},
		],
	});
	const open = body.slice(body.indexOf('## Open prose'), body.indexOf('## Pinned prose'));
	const pinned = body.slice(body.indexOf('## Pinned prose'), body.indexOf('## Code'));
	assert.match(open, /caveman lite \| 1 \| 60 \| -40 \| -40\.0%/);
	assert.match(pinned, /caveman lite \| 1 \| 150 \| 50 \| 50\.0%/, 'the pinned surface keeps its own, opposite result');
});

test('writeOutputResult: a missing rtk binary is reported as unmeasured, not as zero', () => {
	const body = writeOutputResult({
		rtkBinary: null,
		filters: [],
		rewrite: null,
		levels: [{mode: 'caveman', level: 'full', bytes: 100, estimatedTokens: 25, perFiveTurns: 125}],
		measuredAt: '2026-01-01T00:00:00.000Z',
	});
	assert.match(body, /unmeasured: rtk not installed/);
	assert.match(body, /rtk binary: NOT FOUND/);
	assert.doesNotMatch(body, /\| 0 \|/);
});

test('writeOutputResult: a 0% row survives into the report', () => {
	const body = writeOutputResult({
		rtkBinary: '/usr/bin/rtk',
		filters: [
			{case: 'grep, scattered', filter: 'grep', shape: '240 files', inputBytes: 100, outputBytes: 100, reduction: 0, meanMs: 5, p95Ms: 6, samples: 5, fidelity: 'passed through unchanged'},
		],
		rewrite: {commands: 12, rewritten: 12, meanMs: 9, p95Ms: 12},
		levels: [],
		measuredAt: '2026-01-01T00:00:00.000Z',
	});
	assert.match(body, /grep, scattered/);
	assert.match(body, /0\.0%/);
	assert.match(body, /passed through unchanged/);
});

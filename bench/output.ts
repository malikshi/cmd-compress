// bench/output.ts — the exact, reproducible half: rtk filter bytes, rewrite latency, and prompt overhead.
// exports: runOutputBench, writeOutputResult, FILTER_CASES
// used_by: bench/cli.ts, test/bench.test.ts
// related: bench/lib/fixtures.ts, mods/rtk.ts, rules/caveman.ts, rules/ponytail.ts
// rules: prompt overhead is counted per turn, so a mode that shrinks replies can still cost more overall.
// rules: a 0% row is reported, never hidden — rtk declines a regrouping larger than its input, and that is a finding.
// agent: 2026-11-02 initial; split grep into clustered and scattered after learning rtk's never_worse guard

import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CAVEMAN_LEVELS, cavemanRule} from '../rules/caveman.ts';
import {PONYTAIL_LEVELS, ponytailRule} from '../rules/ponytail.ts';
import {resolveBin} from '../mods/shared.ts';
import {canRefilterCompressed, filterForShape, splitSegments, stripAnsi} from '../mods/rtk.ts';
import {
	makeFindOutput,
	makeGlobToolOutput,
	makeGlobToolTruncated,
	makeGrepClustered,
	makeGrepScattered,
	makeGrepToolTruncated,
	makeGrepFilesModeOutput,
	makeGrepCountModeOutput,
	makeShellToolOutput,
	makeShellAbortOutput,
	makeDeclinedBaseline,
	makeColoredBuildOutput,
	REWRITE_COMMANDS,
} from './lib/fixtures.ts';
import {estimateTokens, formatBytes, formatPct, median, percentile, reduction} from './lib/stats.ts';

export interface FilterResult {
	readonly case: string;
	readonly filter: string;
	readonly shape: string;
	readonly inputBytes: number;
	readonly outputBytes: number;
	readonly reduction: number;
	readonly meanMs: number;
	readonly p95Ms: number;
	readonly samples: number;
	readonly fidelity: string;
}

export interface RewriteResult {
	readonly commands: number;
	readonly rewritten: number;
	readonly meanMs: number;
	readonly p95Ms: number;
}

export interface LevelCost {
	readonly mode: string;
	readonly level: string;
	readonly bytes: number;
	readonly estimatedTokens: number;
	readonly perFiveTurns: number;
}

export interface OutputBenchResult {
	readonly rtkBinary: string | null;
	readonly filters: readonly FilterResult[];
	readonly rewrite: RewriteResult | null;
	readonly levels: readonly LevelCost[];
	readonly measuredAt: string;
}

const FILTER_SAMPLES = 5;

// Rules: both grep shapes are measured because they answer different questions about the same filter.
export const FILTER_CASES = [
	{
		case: 'grep, clustered',
		filter: 'grep',
		shape: '240 matches in 6 files (40 per file)',
		build: () => makeGrepClustered(),
	},
	{
		case: 'grep, scattered',
		filter: 'grep',
		shape: '240 matches in 240 files (1 per file)',
		build: () => makeGrepScattered(),
	},
	{
		case: 'find',
		filter: 'find',
		shape: '260 paths in 10 dirs',
		build: () => makeFindOutput(),
	},
] as const;

// Rules: the raw fixtures above are rtk's own input shape. These are Command Code's — a header, a trailer, and an exit status around the same body. The envelope must survive, so each row asserts it.
export const ENVELOPE_CASES = [
	{case: 'glob tool', filter: 'find', tool: 'glob', shape: '260 paths + Found header', build: () => makeGlobToolOutput()},
	{case: 'glob tool, truncated', filter: 'find', tool: 'glob', shape: '260 paths + truncation notice', build: () => makeGlobToolTruncated()},
	{case: 'grep tool, truncated', filter: 'grep', tool: 'grep', shape: '240 matches + pagination notice', build: () => makeGrepToolTruncated()},
	{case: 'grep tool, files mode', filter: 'grep', tool: 'grep', shape: '300 paths + Found header (find filter takes over)', build: () => makeGrepFilesModeOutput()},
	{case: 'grep tool, count mode', filter: 'grep', tool: 'grep', shape: '400 hits + total-occurrences notice', build: () => makeGrepCountModeOutput()},
	{case: 'shell tool', filter: null, tool: 'shell_command', shape: 'cargo failure + Exit code head', build: () => makeShellToolOutput()},
	{case: 'shell tool, timed out', filter: null, tool: 'shell_command', shape: 'pytest failure + timeout notice', build: () => makeShellAbortOutput()},
	{case: 'shell tool, declined grep baseline', filter: null, tool: 'shell_command', shape: 'multi-file match rows rtk refused to group', build: () => makeDeclinedBaseline(), rewritten: true},
	{case: 'shell tool, coloured build', filter: null, tool: 'shell_command', shape: '40 tsc errors with SGR colour', build: () => makeColoredBuildOutput()},
] as const;

// Rules: rtk pipe takes stdin only, so the fixture is redirected from a temp file rather than interpolated into a command line.
function pipeThrough(bin: string, filter: string | null, input: string): string | null {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), 'cmd-compress-bench-'));
		const file = join(dir, 'in.txt');
		writeFileSync(file, input, 'utf8');
		const flags = filter ? `-f ${filter} ` : '';
		return execFileSync('/bin/sh', ['-c', `"${bin}" pipe ${flags}< "${file}"`], {encoding: 'utf8', timeout: 10_000});
	} catch {
		return null;
	} finally {
		if (dir) rmSync(dir, {recursive: true, force: true});
	}
}

// Rules: this mirrors the mod's own condense() step exactly — pick the filter from the shape, split the host envelope off, strip colour, filter only the body, put the envelope back. Measuring a path production does not run is what let the envelope bug through.
// Rules: a rewritten shell call is skipped unless rtk left its faithful baseline, so the cases say which they model. An unrewritten call (`npm test`) is filtered unconditionally; a rewritten one goes through the same gate production uses.
function condenseTool(bin: string, filter: string | null, tool: string, input: string, rewritten = false): {stdout: string; fidelity: string} | null {
	const plain = stripAnsi(input);
	const strippedAsEnvelope = splitSegments(tool, plain);
	if (rewritten && !canRefilterCompressed(plain)) {
		return plain.length < input.length ? {stdout: plain, fidelity: 'colour stripped, rtk left the baseline'} : null;
	}
	const shapeFilter = filterForShape(tool, filter, input);
	const {head, body, tail} = splitSegments(tool, input);
	const filtered = pipeThrough(bin, shapeFilter, stripAnsi(body));
	if (filtered === null) {
		if (plain.length >= input.length) return null;
		return {stdout: `${strippedAsEnvelope.head}${strippedAsEnvelope.body}${strippedAsEnvelope.tail}`, fidelity: 'colour stripped, filter declined'};
	}
	const composed = `${head}${filtered}${tail}`;
	const keptHead = head === '' || composed.startsWith(head);
	const keptTail = tail === '' || composed.endsWith(tail);
	const notes = [head.trim() ? `header ${keptHead ? 'kept' : 'LOST'}` : '', tail.trim() ? `trailer ${keptTail ? 'kept' : 'LOST'}` : ''].filter(Boolean);
	return {stdout: composed, fidelity: notes.length ? notes.join(', ') : 'no envelope'};
}

// Rules: fidelity is asserted, not assumed — a filter that drops a whole file is a failed run and says so.
function grepFidelity(input: string, output: string): string {
	const lines = input.split('\n').filter(Boolean);
	const files = new Set(lines.map(line => line.split(':')[0] ?? ''));
	const named = [...files].filter(file => output.includes(file)).length;
	const kept = output.split('\n').filter(line => /^\s*\d+:/.test(line)).length;
	if (output === input) return `passed through unchanged (${lines.length} matches, ${files.size} files)`;
	return `${named}/${files.size} files named, ${kept} of ${lines.length} match lines kept`;
}

function findFidelity(input: string, output: string): string {
	const paths = input.split('\n').filter(Boolean);
	const dirs = new Set(paths.map(path => path.slice(0, path.lastIndexOf('/'))));
	const named = [...dirs].filter(dir => output.includes(dir)).length;
	const counts = /(\d+) files? in (\d+) dirs?/.exec(output);
	const header = counts ? `header claims ${counts[1]} files in ${counts[2]} dirs` : 'no header';
	if (output === input) return `passed through unchanged (${paths.length} paths)`;
	return `${named}/${dirs.size} dirs named, ${header}`;
}

// Rules: the rewrite contract is "a rewrite or a clean exit 1"; anything else is reported as a miss.
function measureRewrite(bin: string): RewriteResult {
	const times: number[] = [];
	let rewritten = 0;
	for (const command of REWRITE_COMMANDS) {
		const started = process.hrtime.bigint();
		try {
			const stdout = execFileSync(bin, ['rewrite', command], {encoding: 'utf8', timeout: 5000});
			times.push(Number(process.hrtime.bigint() - started) / 1_000_000);
			if (stdout.trim()) rewritten += 1;
		} catch {
			times.push(Number(process.hrtime.bigint() - started) / 1_000_000);
			// exit 1 is the documented "no rtk equivalent" answer, not a failure
		}
	}
	return {
		commands: REWRITE_COMMANDS.length,
		rewritten,
		meanMs: times.reduce((sum, value) => sum + value, 0) / Math.max(1, times.length),
		p95Ms: percentile(times, 95),
	};
}

// Rules: the injected block is the only cost a mode adds to a prompt, so it is measured at its exact size.
function levelCosts(): LevelCost[] {
	const rows: LevelCost[] = [];
	for (const level of CAVEMAN_LEVELS) {
		const body = cavemanRule(level);
		rows.push({
			mode: 'caveman',
			level,
			bytes: Buffer.byteLength(body, 'utf8'),
			estimatedTokens: estimateTokens(body),
			perFiveTurns: estimateTokens(body) * 5,
		});
	}
	for (const level of PONYTAIL_LEVELS) {
		const body = ponytailRule(level);
		rows.push({
			mode: 'ponytail',
			level,
			bytes: Buffer.byteLength(body, 'utf8'),
			estimatedTokens: estimateTokens(body),
			perFiveTurns: estimateTokens(body) * 5,
		});
	}
	return rows;
}

export function runOutputBench(): OutputBenchResult {
	const bin = resolveBin('rtk');
	const filters: FilterResult[] = [];

	if (bin) {
		for (const testCase of FILTER_CASES) {
			const input = testCase.build();
			const inputBytes = Buffer.byteLength(input, 'utf8');
			const samples: number[] = [];
			let output = '';
			for (let index = 0; index < FILTER_SAMPLES; index += 1) {
				const started = process.hrtime.bigint();
				output = pipeThrough(bin, testCase.filter, input) ?? '';
				samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
			}
			if (!output) continue;
			const outputBytes = Buffer.byteLength(output, 'utf8');
			filters.push({
				case: testCase.case,
				filter: testCase.filter,
				shape: testCase.shape,
				inputBytes,
				outputBytes,
				reduction: reduction(inputBytes, outputBytes),
				meanMs: median(samples),
				p95Ms: percentile(samples, 95),
				samples: samples.length,
				fidelity: testCase.filter === 'find' ? findFidelity(input, output) : grepFidelity(input, output),
			});
		}

		// Rules: measured through the mod's own split-then-filter path, so the number reflects what a session actually gets.
		for (const testCase of ENVELOPE_CASES) {
			const input = testCase.build();
			const inputBytes = Buffer.byteLength(input, 'utf8');
			const samples: number[] = [];
			let output = '';
			let fidelity = 'unmeasured';
			for (let index = 0; index < FILTER_SAMPLES; index += 1) {
				const started = process.hrtime.bigint();
				const result = condenseTool(bin, testCase.filter, testCase.tool, input, 'rewritten' in testCase && testCase.rewritten);
				samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
				if (!result) break;
				output = result.stdout;
				fidelity = result.fidelity;
			}
			if (!output) continue;
			const outputBytes = Buffer.byteLength(output, 'utf8');
			filters.push({
				case: testCase.case,
				filter: testCase.filter ?? 'auto',
				shape: testCase.shape,
				inputBytes,
				outputBytes,
				reduction: reduction(inputBytes, outputBytes),
				meanMs: median(samples),
				p95Ms: percentile(samples, 95),
				samples: samples.length,
				fidelity,
			});
		}
	}

	return {
		rtkBinary: bin,
		filters,
		rewrite: bin ? measureRewrite(bin) : null,
		levels: levelCosts(),
		measuredAt: new Date().toISOString(),
	};
}

// Rules: the result file states the binary path and the sample count so a reader can judge reproducibility.
export function writeOutputResult(result: OutputBenchResult): string {
	const lines: string[] = [];
	lines.push('# Command output benchmark');
	lines.push('');
	lines.push(`Measured: ${result.measuredAt}`);
	lines.push(`rtk binary: ${result.rtkBinary ?? 'NOT FOUND — the filter rows are unmeasured, not zero'}`);
	lines.push('');
	lines.push('Byte ratios reproduce across machines. Milliseconds do not — compare percentages.');
	lines.push('');

	lines.push('| Case | Shape | Bytes in | Bytes out | Saved | Mean | Fidelity |');
	lines.push('|---|---|---:|---:|---:|---:|---|');
	if (result.filters.length === 0) {
		lines.push('| _unmeasured: rtk not installed_ | | | | | | |');
	} else {
		for (const filter of result.filters) {
			lines.push(
				`| ${filter.case} | ${filter.shape} | ${formatBytes(filter.inputBytes)} | ${formatBytes(filter.outputBytes)} | ${formatPct(filter.reduction)} | ${filter.meanMs.toFixed(0)} ms | ${filter.fidelity} |`,
			);
		}
	}

	lines.push('');
	lines.push('| Case | Commands | Rewritten | Mean | p95 |');
	lines.push('|---|---:|---:|---:|---:|');
	if (result.rewrite) {
		lines.push(
			`| rewrite lookup | ${result.rewrite.commands} | ${result.rewrite.rewritten} | ${result.rewrite.meanMs.toFixed(1)} ms | ${result.rewrite.p95Ms.toFixed(1)} ms |`,
		);
	} else {
		lines.push('| _unmeasured: rtk not installed_ | | | | |');
	}

	lines.push('');
	lines.push('## Prompt overhead per mode');
	lines.push('');
	lines.push('The block is injected once per session and re-sent every turn. Estimated tokens use chars/4 — an estimate, not a tokenizer count.');
	lines.push('');
	lines.push('| Mode | Level | Bytes | Est. tokens | Est. tokens over 5 turns |');
	lines.push('|---|---|---:|---:|---:|');
	for (const level of result.levels) {
		lines.push(
			`| ${level.mode} | ${level.level} | ${formatBytes(level.bytes)} | ~${level.estimatedTokens} | ~${level.perFiveTurns} |`,
		);
	}

	lines.push('');
	return `${lines.join('\n')}\n`;
}

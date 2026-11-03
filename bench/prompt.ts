// bench/prompt.ts — the live half: reply tokens per mode against base, measured by real sessions.
// exports: runPromptBench, writePromptResult, readUsage, MODE_CASES
// used_by: bench/cli.ts, test/bench.test.ts
// related: bench/lib/prompts.ts
// rules: every case is measured in a fresh process with the same prompts, so the only variable is the mode.
// rules: a case with fewer than MIN_RUNS samples is reported as partial, never as a clean median.
// rules: output tokens are the model's generated text; input tokens are reported separately and include the mode's block.
// agent: 2026-11-02 initial

import {execFileSync} from 'node:child_process';
import {CODE_PROMPTS, PROMPT_BUDGET, PROSE_OPEN, PROSE_PROMPTS, checkCode, checkProse} from './lib/prompts.ts';
import {median} from './lib/stats.ts';

export type Surface = 'pinned' | 'open' | 'code';

export interface PromptRun {
	readonly surface: Surface;
	readonly promptId: string;
	readonly replyTokens: number;
	readonly inputTokens: number;
	readonly durationMs: number;
	readonly passed: boolean;
	readonly chars: number;
}

export interface PromptCase {
	readonly name: string;
	readonly modes: Record<string, string>;
	readonly runs: readonly PromptRun[];
	readonly failures: Readonly<Record<string, number>>;
}

export interface PromptBenchResult {
	readonly cases: readonly PromptCase[];
	readonly model: string | null;
	readonly runs: number;
	readonly measuredAt: string;
}

// Rules: `control` is a plain "Answer concisely." instruction — without it, caveman's gain cannot be told apart from a shorter-answer request.
export const MODE_CASES: readonly {name: string; modes: Record<string, string>}[] = [
	{name: 'base', modes: {}},
	{name: 'control', modes: {control: 'on'}},
	{name: 'caveman lite', modes: {caveman: 'lite'}},
	{name: 'caveman full', modes: {caveman: 'full'}},
	{name: 'caveman ultra', modes: {caveman: 'ultra'}},
	{name: 'caveman megacave-full', modes: {caveman: 'megacave-full'}},
	{name: 'ponytail full', modes: {ponytail: 'full'}},
	{name: 'ponytail ultra', modes: {ponytail: 'ultra'}},
	{name: 'compress balanced', modes: {caveman: 'full', ponytail: 'full', rtk: 'on'}},
	{name: 'compress max', modes: {caveman: 'ultra', ponytail: 'ultra', rtk: 'on'}},
];

export const MIN_RUNS = 3;

interface Usage {
	inputTokens?: number;
	outputTokens?: number;
}

// Rules: the last line of an NDJSON run is the result frame; earlier frames are progress and carry no totals.
export function readUsage(stdout: string): {usage: Usage; durationMs: number; finalText: string} | null {
	const lines = stdout.split('\n').filter(line => line.trim().startsWith('{'));
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const frame = JSON.parse(lines[index] ?? '') as {
				type?: string;
				usage?: Usage;
				durationMs?: number;
				finalText?: string;
				subtype?: string;
			};
			if (frame.type === 'result' && frame.subtype === 'success') {
				return {usage: frame.usage ?? {}, durationMs: frame.durationMs ?? 0, finalText: frame.finalText ?? ''};
			}
		} catch {
			// a partial or non-JSON line is skipped; the result frame is what matters
		}
	}
	return null;
}

function modArgs(caseName: string): string[] {
	return ['--mod', 'mods/caveman.ts', '--mod', 'mods/ponytail.ts', '--mod', 'mods/rtk.ts', '--mod', 'mods/compress.ts'];
}

// Rules: the control is a system-prompt sentence, not a mode, so it is injected by a tiny inline mod instead of a fake level.
const CONTROL_MOD = `bench/lib/control.ts`;

function modeArgs(modes: Record<string, string>): string[] {
	const args: string[] = [];
	for (const [key, value] of Object.entries(modes)) {
		if (key === 'control') {
			args.push('--mod', CONTROL_MOD);
			continue;
		}
		args.push('--mod-option', `${key}=${value}`);
	}
	return args;
}

function runOnce(promptText: string, modes: Record<string, string>, model: string | null): {
	usage: Usage;
	durationMs: number;
	finalText: string;
} | null {
	const args = [
		'-p',
		promptText,
		'--output-format',
		'json',
		'--max-turns',
		String(PROMPT_BUDGET.maxTurns),
		'--dangerously-skip-permissions',
		...modArgs(''),
		...modeArgs(modes),
	];
	if (model) args.push('--model', model);
	try {
		const stdout = execFileSync('cmd', args, {
			encoding: 'utf8',
			timeout: PROMPT_BUDGET.timeoutMs,
			maxBuffer: 32 * 1024 * 1024,
			stdio: ['ignore', 'pipe', 'ignore'],
		});
		return readUsage(stdout);
	} catch (error) {
		// Rules: exit 8 is max-turns and exit 124-ish is the timeout; both are recorded, never silently retried away.
		const status = (error as {status?: number}).status;
		lastFailure = status === 8 ? 'max-turns' : status === undefined ? 'timeout' : `exit-${status}`;
		return null;
	}
}

// Rules: the failure label is a module-scoped slot read immediately after a null return, so it never crosses a run.
let lastFailure = 'unknown';

export function runPromptBench(options: {model?: string | null; runs?: number} = {}): PromptBenchResult {
	const runs = Math.max(MIN_RUNS, options.runs ?? MIN_RUNS);
	const model = options.model ?? null;
	const cases: PromptCase[] = [];

	for (const modeCase of MODE_CASES) {
		const collected: PromptRun[] = [];
		const failures: Record<string, number> = {};
		const record = (surface: Surface, promptId: string, text: string, check: (reply: string) => boolean) => {
			const result = runOnce(text, modeCase.modes, model);
			if (!result) {
				failures[lastFailure] = (failures[lastFailure] ?? 0) + 1;
				return;
			}
			// Rules: a run that ended without any answer text is a failure, not a zero-token sample that drags the median down.
			if (!result.finalText.trim()) {
				failures['empty-reply'] = (failures['empty-reply'] ?? 0) + 1;
				return;
			}
			collected.push({
				surface,
				promptId,
				replyTokens: result.usage.outputTokens ?? 0,
				inputTokens: result.usage.inputTokens ?? 0,
				durationMs: result.durationMs,
				passed: check(result.finalText),
				chars: result.finalText.length,
			});
		};

		for (let iteration = 0; iteration < runs; iteration += 1) {
			for (const prompt of PROSE_OPEN) record('open', prompt.id, prompt.text, reply => checkProse(reply, prompt));
			for (const prompt of PROSE_PROMPTS) record('pinned', prompt.id, prompt.text, reply => checkProse(reply, prompt));
			for (const prompt of CODE_PROMPTS) record('code', prompt.id, prompt.text, reply => checkCode(reply, prompt));
		}
		cases.push({name: modeCase.name, modes: modeCase.modes, runs: collected, failures});
	}

	return {cases, model, runs, measuredAt: new Date().toISOString()};
}

const SURFACES: readonly {key: Surface; label: string; note: string}[] = [
	{
		key: 'open',
		label: 'Open prose (O1–O3)',
		note: 'The answer length is the model\'s choice, so this is the fair test of a brevity mode.',
	},
	{
		key: 'pinned',
		label: 'Pinned prose (P1–P3)',
		note: 'Each prompt asks for "three sentences", so the reply size is fixed by the prompt and a delta here measures noise, not the mode.',
	},
	{
		key: 'code',
		label: 'Code (C1–C3)',
		note: 'Function names are fixed and the prompt asks for code only, so reply size is mostly the code the answer needs.',
	},
];

function expectedRuns(result: PromptBenchResult): number {
	return result.runs * (PROSE_OPEN.length + PROSE_PROMPTS.length + CODE_PROMPTS.length);
}

function medianOf(runs: readonly PromptRun[], pick: (run: PromptRun) => number): number {
	return median(runs.map(pick));
}

// Rules: each surface is reported on its own line, because a mean over a length-pinned prompt hides the mode's effect.
// Rules: full is the only quality mark — a case short of its run count says "partial", never a fabricated median.
export function writePromptResult(result: PromptBenchResult): string {
	const total = expectedRuns(result);
	const failures = new Map<string, number>();
	for (const entry of result.cases) {
		for (const [reason, count] of Object.entries(entry.failures)) {
			failures.set(reason, (failures.get(reason) ?? 0) + count);
		}
	}

	const lines: string[] = [];
	lines.push('# Live prompt benchmark');
	lines.push('');
	lines.push(`Measured: ${result.measuredAt}`);
	lines.push(`Model: ${result.model ?? 'session default'}`);
	lines.push(`Runs per case: ${result.runs} × ${PROSE_OPEN.length + PROSE_PROMPTS.length + CODE_PROMPTS.length} prompts = ${total}`);
	lines.push('');
	lines.push('Every case ran in a fresh headless process with the same prompts. Reply tokens are the model-output count from the session usage, not an estimate. Reported per surface, because a length-pinned prompt cannot show a brevity effect.');
	lines.push('');

	for (const surface of SURFACES) {
		const base = result.cases.find(entry => entry.name === 'base');
		const baseRuns = base ? base.runs.filter(run => run.surface === surface.key) : [];
		const baseMedian = medianOf(baseRuns, run => run.replyTokens);
		const baseInput = medianOf(baseRuns, run => run.inputTokens);
		const basePass = baseRuns.filter(run => run.passed).length;

		lines.push(`## ${surface.label}`);
		lines.push('');
		lines.push(surface.note);
		lines.push('');
		lines.push('| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |');
		lines.push('|---|---:|---:|---:|---:|---:|---|');

		for (const entry of result.cases) {
			const runs = entry.runs.filter(run => run.surface === surface.key);
			const expected = result.runs * (surface.key === 'code' ? CODE_PROMPTS.length : BASE_PROMPT_COUNT(surface.key));
			if (runs.length === 0) {
				lines.push(`| ${entry.name} | 0 | — | — | — | — | partial (0/${expected}) |`);
				continue;
			}
			const replyMedian = medianOf(runs, run => run.replyTokens);
			const inputMedian = medianOf(runs, run => run.inputTokens);
			const passed = runs.filter(run => run.passed).length;
			const isBase = entry.name === 'base';
			const delta = isBase ? 0 : replyMedian - baseMedian;
			const pct = !isBase && baseMedian > 0 ? (delta / baseMedian) * 100 : 0;
			const quality = runs.length === expected ? `${passed}/${runs.length}` : `partial (${runs.length}/${expected})`;
			lines.push(
				`| ${entry.name} | ${runs.length} | ${replyMedian.toFixed(0)} | ${isBase ? '0' : delta.toFixed(0)} | ${isBase ? '0%' : `${pct.toFixed(1)}%`} | ${inputMedian.toFixed(0)} | ${quality} |`,
			);
		}

		lines.push('');
		lines.push(`Base reference: reply median ${baseMedian.toFixed(0)}, input median ${baseInput.toFixed(0)}, quality ${basePass}/${baseRuns.length}.`);
		lines.push('');
	}

	if (failures.size > 0) {
		const summary = [...failures.entries()].map(([reason, count]) => `${reason}: ${count}`).join(', ');
		lines.push(`**Failed runs, excluded from the medians:** ${summary}.`);
		lines.push('');
	}
	lines.push('Read Δ Tokens beside Input median. A mode can cut reply tokens and still add tokens overall, because its block is re-sent every turn.');
	lines.push('');
	const incomplete = result.cases.some(entry => entry.runs.length < total);
	if (incomplete) {
		lines.push('**This table is incomplete.** A case short of its run count is a partial sample, so its median is not a clean result.');
		lines.push('');
	}
	return `${lines.join('\n')}\n`;
}

function BASE_PROMPT_COUNT(surface: Surface): number {
	return surface === 'open' ? PROSE_OPEN.length : PROSE_PROMPTS.length;
}

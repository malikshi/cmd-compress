// bench/cli.ts — the two entry points: the exact output bench and the live prompt bench.
// exports: none
// used_by: npm run bench, npm run bench:prompt
// related: bench/output.ts, bench/prompt.ts
// rules: the output bench always runs; the live bench costs real tokens, so it only runs when asked.
// agent: unknown | unknown | 2026-11-02 | unknown | initial
// agent: unknown | xai | 2026-11-04 | 01a1a3cc | ROOT uses fileURLToPath, so a checkout path with a space is not percent-encoded

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runOutputBench, writeOutputResult} from './output.ts';
import {runPromptBench, writePromptResult} from './prompt.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function write(name: string, body: string): void {
	const target = join(ROOT, 'bench', 'results', name);
	writeFileSync(target, body, 'utf8');
	process.stdout.write(`\nwrote bench/results/${name}\n`);
}

// Rules: a rerun never destroys the previous run — the variance between runs is a finding, not an accident.
function archive(name: string, body: string): void {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const base = name.replace(/\.md$/, '');
	const target = join(ROOT, 'bench', 'results', `${base}-${stamp}.md`);
	writeFileSync(target, body, 'utf8');
	process.stdout.write(`archived bench/results/${base}-${stamp}.md\n`);
}

const mode = process.argv[2] ?? 'output';

if (mode === 'output') {
	const result = runOutputBench();
	const body = writeOutputResult(result);
	process.stdout.write(body);
	write('output.md', body);
} else if (mode === 'prompt') {
	const runs = Number(process.argv[3] ?? 3);
	const model = process.argv[4] ?? null;
	process.stdout.write(`running the live bench: ${runs} runs per case, model ${model ?? 'session default'}\n`);
	const result = runPromptBench({runs, model});
	const body = writePromptResult(result);
	process.stdout.write(body);
	write('prompt.md', body);
	archive('prompt', body);
} else {
	console.error('usage: node bench/cli.ts [output|prompt] [runs] [model]');
	process.exit(1);
}

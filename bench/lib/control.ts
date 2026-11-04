// bench/lib/control.ts — the benchmark's control condition: a plain "Answer concisely." instruction.
// exports: default (ModFactory)
// used_by: bench/prompt.ts (as --mod for the control case)
// related: bench/lib/prompts.ts
// rules: the control injects an instruction, not a mode — it exists to separate "shorter" from "caveman".
// agent: unknown | unknown | 2026-11-02 | unknown | initial

import type {ModApi} from '@commandcode/harness';

export default function (cmd: ModApi): void {
	cmd.hooks({
		appendSystemPrompt: () => 'Answer concisely.',
	});
}

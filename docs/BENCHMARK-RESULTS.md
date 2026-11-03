# Measured results

Measured 2026-11-02. Model `nexrouter/deepseek-v4.1-flash`, Command Code `1.88.2`, rtk `1.0.1`, Linux.

Two full live runs, same day, same model, same prompts: [`prompt-run-a.md`](../bench/results/prompt-run-a.md) and [`prompt-run-b.md`](../bench/results/prompt-run-b.md). Both are published because they disagree, and the disagreement is the most important result here.

Protocol: [BENCHMARK.md](./BENCHMARK.md). Reproduce with `npm run bench` and `npm run bench:prompt -- 5 <model>`.

## 0. Read this first

**The run-to-run variance is larger than most of the effects being measured.** Base reply median moved from **407 to 525 tokens** (+29%) between two runs of the *same* configuration. Only **4 of 9** mode deltas kept their sign across the two runs:

| Case | Run A Δ% | Run B Δ% | Stable? |
|---|---:|---:|---|
| control | −1.5% | −21.1% | sign holds, size does not |
| caveman lite | +13.0% | −16.0% | **flips** |
| caveman full | +31.4% | +9.5% | sign holds |
| caveman ultra | −12.0% | −13.1% | **holds** |
| caveman megacave-full | +75.7% | +58.7% | **holds** |
| ponytail full | +27.5% | −12.6% | **flips** |
| ponytail ultra | +4.4% | −24.8% | **flips** |
| compress balanced | +3.4% | −4.6% | **flips** |
| compress max | +0.7% | −6.9% | **flips** |

**5 runs per prompt per case is not enough to resolve a ±20% effect on this model.** Any single-run table of these modes is noise, including one from this repository. What follows reports only what survived both runs.

## 1. Command output — exact and reproducible

From `npm run bench`. No model involved; these bytes are the same on any machine with the same rtk.

### Raw output, rtk's own input shape

| Case | Shape | Bytes in | Bytes out | Saved | Fidelity |
|---|---|---:|---:|---:|---|
| grep, clustered | 240 matches in 6 files | 16,130 | 3,148 | **80.5%** | 6/6 files named, 60 of 240 match lines kept |
| grep, scattered | 240 matches in 240 files | 14,874 | 14,874 | **0.0%** | passed through unchanged |
| find | 260 paths in 10 dirs | 6,092 | 1,748 | **71.3%** | 10/10 dirs named, header correct |

### Command Code's own tool shapes

The raw rows above are rtk's fixture, not what this host produces. A `glob` result opens with `Found N files`, a truncated `glob` closes with `(Results are truncated: showing 1-100 of 382 matches …)`, a truncated `grep` closes with `[Showing results with pagination = …]` or `Found N total occurrences across M files …`, and `shell_command` opens with the exit status and may close with `Command aborted` or `Command timed out after …`. These rows run the mod's real split → filter → re-attach path, and the fidelity column asserts the envelope survived.

| Case | Envelope | Bytes in | Bytes out | Saved | Fidelity |
|---|---|---:|---:|---:|---|
| glob tool | `Found 260 files` header | 4,326 | 1,149 | **73.4%** | header kept |
| glob tool, truncated | header + truncation notice | 5,021 | 1,345 | **73.2%** | header kept, trailer kept |
| grep tool, truncated | pagination notice | 15,540 | 3,183 | **79.5%** | trailer kept |
| grep tool, files mode | `Found 300 files …` header (find filter) | 4,448 | 620 | **86.1%** | header kept |
| grep tool, count mode | total-occurrences notice | 17,228 | 14,420 | **16.3%** | trailer kept |
| shell tool | `Exit code: 1` head | 2,769 | 324 | **88.3%** | header kept |
| shell tool, timed out | header + timeout notice | 5,889 | 340 | **94.2%** | header kept, trailer kept |
| shell tool, declined grep baseline | none — rtk refused to group | 8,081 | 514 | **93.6%** | no envelope |

### The declined baseline

rtk's search filter prints its **faithful baseline** whenever capping would not shrink the output. That is the normal case for a multi-file grep: `grep -rn export mods` measured 4,026 → 4,026 bytes through `rtk grep`, so a command rtk rewrote still reached the model at full size. The mod now recognises that baseline — no recovery marker, and a majority of `path:line:text` rows — and runs one more filter pass over it.

| Command | rtk grep | After 2nd pass | Recovered |
|---|---:|---:|---:|
| `grep -rn export mods` | 4,206 | 2,691 | **36.0%** |
| `grep -rn function mods` | 3,723 | 2,475 | **33.5%** |
| `grep -rn Rules: …/contract` | 1,984 | 1,325 | **33.2%** |
| `rtk grep -rn export mods` | 4,206 | 2,691 | **36.0%** |

The gate has to exist because the opposite is destructive: one blind second pass over rtk-grouped output **deleted all 9 `rtk recall` hints** from it, and a recall hash is unrecoverable once its hint is gone. So anything carrying `matches in N files:`, `+N more`, `+ … more files`, `[+N hidden: rtk recall …]` or `[full output: rtk recall …]` is left byte-identical to what rtk emitted.

Cost is bounded: the second pass measured **12 ms** median (`rtk pipe` on a 5 KB result), and it is skipped entirely below the 1,200-byte threshold and for every non-match-list shape. Twelve real rewritten commands (`git status`, `git log`, `git diff`, `npm test`, `npx tsc`, `ls`, `find`, `git branch`, `du`) measured **0 bytes changed** — the gate does not fire on them at all.

A live headless run against a fixture repo confirms it outside the bench: a `glob` of 380 files came back as `Found 100 files` plus rtk's grouped body and the host's own truncation notice intact — **1,771 → 471 bytes**, every directory named.

Those rows exist because an earlier build lost or skipped every one of them. Each was found by reading the host's own formatter and the real binary's output, not by guessing:

- The `find` filter read `Found N files` as a path, the `grep` filter folded the pagination notice away as noise, and the shell pass folded away `Exit code: 1`. Fixed by filtering only the body and re-attaching the host's envelope verbatim.
- The truncation notice was a second discovery: the first fix guessed at `[…]` when the host prints `(Results are truncated: showing 1-100 of 382 matches …)`.
- **Count mode, the timeout notice, the cwd note and the edition banner were still being folded away.** `rtk pipe` dropped `Found N total occurrences across M files …`, `[Search timed out — …]`, `Command timed out after 120000ms (exit code 124). …`, `[cwd change to …]` and `[PowerShell edition: …]`, and the mod's trailer regex matched none of them — measured, the whole tail vanished from the model's view.
- **The interpreted exit code was lost.** `formatResult2` writes `(No matches found)` on its own line under `Exit code: 1`; that line went into the body and was folded.
- **`grep`'s default mode compressed nothing.** The tool defaults to `files_with_matches`, a path list under a `Found N files` header. The mod forced `-f grep`, which returns that shape byte-identical (4,448 → 4,448); the shape now selects the find filter instead (→ 620).

Rewrite: 12 of 12 commands rewritten, ~77 ms mean, ~82 ms p95.

**The scattered row is the important one.** It saves nothing, and that is not a bug: rtk's `never_worse` guard refuses a regrouping larger than its input. Reporting only the clustered case would have claimed 80% as if it were universal. The honest claim is *"a shell result that groups by file gets much smaller; a result with one hit per file is unchanged."*

**Fidelity has a cost.** Clustered grep keeps 60 of 240 match lines — it folds each file's tail behind `+N`. Fewer bytes, fewer lines, every named file still present. A grep result where those folded lines mattered will read worse, not better.

## 2. Prompt overhead — the one solid live result

The block a mode injects is measured twice: statically (chars/4 of the rules text) and live (input tokens against base). Measured on the open surface, which is stable across both runs because it does not depend on the model's reply.

| Case | Live overhead | Static estimate | Ratio |
|---|---:|---:|---:|
| control | +5 to +35 | ~7 | — |
| caveman lite | +150 | ~231 | 0.65 |
| caveman full | +455 to +457 | ~465 | 0.98 |
| caveman ultra | +232 | ~243 | 0.95 |
| caveman megacave-full | +281 | ~300 | 0.94 |
| ponytail full | +536 | ~600 | 0.90 |
| ponytail ultra | +552 | ~618 | 0.90 |
| compress balanced | +1,220 to +1,247 | ~1,065 | 1.17 |
| compress max | +1,009 to +1,040 | ~857 | 1.21 |

The live column is from the run recorded above. The static column is recomputed from the shipped rule text, which has since grown: `lite` gained the language, never-perform and one-term-per-thing clauses, and the megacave registers gained their floor paragraph. Those clauses are the reason `lite` now estimates higher than its live measurement — the two columns describe different revisions of the text, and only the static one reflects what ships today. Re-run `npm run bench` against a live model to refresh the left column.

Single-mode estimates land within 10%. The **preset rows read 17–21% higher** than the sum of their blocks, so two blocks do not simply add — treat the static estimate as a floor for a preset.

This is the result to trust, because it is a measurement of text, not of model behaviour, and it reproduced across both runs.

## 3. Does caveman shorten replies?

**Only `ultra`, and only modestly.** It is the one level whose sign held on both runs:

| Case | Run A | Run B |
|---|---:|---:|
| caveman ultra (open prose) | −12.0% | −13.1% |
| caveman full | **+31.4%** | **+9.5%** |
| caveman lite | +13.0% | −16.0% |

`full` cost reply tokens in both runs — the level that reads as the "default" compressed voice is not the saving one on this model. `lite` flipped sign, so it is unmeasured.

The cost is a floor: caveman `ultra` saves ~50–70 reply tokens and adds **232** input tokens for its block on every turn. On a one-turn question it loses. It only pays off across many turns with a warm prompt cache, which this bench does not measure.

**Paradox worth stating:** richer instructions make this model write more. Caveman's blocks are *instructions about style*, and this model appears to treat a longer style brief as licence for a longer answer. `ultra` had the shortest block at the time of the run (953 bytes; 973 after the floor was hoisted to every level) and was the only one that saved — consistent with that explanation, though two runs cannot prove it.

## 4. The pinned-surface control experiment

The pinned prompts ("in three sentences") exist to show why prompt shape matters. On them, the same modes reverse:

| Case | Open (run A) | Pinned (run A) |
|---|---:|---:|
| caveman full | +31.4% | **−14.3%** |
| caveman ultra | −12.0% | **+6.3%** |
| megacave-full | +75.7% | +112.5% |

`full` and `ultra` swap places. That reversal is the proof that a length-pinned prompt measures the prompt, not the mode — the prompt already fixed the length, so what is left is noise. Run B shows the same instability on the pinned rows.

Base quality on the pinned surface is only **9–10 of 15**: the model rarely hits exactly three sentences, so this surface also fails its own gate. It is reported because a missing row is the only real dishonesty in a benchmark.

## 5. Ponytail

Measured on token count, which is the wrong axis for it: ponytail changes the *shape* of code, not the length of the answer. Its deltas flipped sign between runs (`full`: +27.5% → −12.6%). The only fair statement is the overhead row: ponytail `full` costs about **+536 input tokens per turn**.

Choosing between "not shorter" and "genuinely leaner" needs a test suite and a review gate. This repository does not claim either.

## 6. megacave (Classical Chinese)

Consistently the most expensive on every surface and both runs (open: +58.7%, +75.7%). It produces a correct, very dense answer in a Classical Chinese register — verified by reading a sample, not by the keyword gate.

An earlier run recorded its quality as 4/15 because the gate checked English substrings only. That was a **gate artifact**, not a mode failure; the gate is now bilingual and run B measured 14/15. Both numbers are kept in the published runs rather than overwritten.

Worth it only if the reader wants that register. On a code task it is a cost with no measured return.

## 7. Honest summary

| Claim | Supported? |
|---|---|
| Shell output gets smaller | **Conditionally, exactly measured.** 80.5% on file-clustered grep, 71.3% on `find`, **0%** when hits are one-per-file. |
| A mode adds prompt overhead | **Yes, reproducible.** Within 10% of the static estimate for a single mode; presets read ~20% above it. |
| Caveman shortens replies | **Only `ultra`, by ~12–13%**, and only on open prompts. `full` costs more in both runs. |
| The mode pays for itself in one turn | **No.** `ultra` saves ~50–70 reply tokens against a 232-token block. |
| Ponytail produces leaner code | **Not measured.** Reply tokens cannot show it; needs a test/review gate. |
| Any dollar saving | **Not claimed.** No price table, no bill figure. |
| This bench can rank modes to ±10% | **No.** Only 4 of 9 deltas kept their sign across two runs. |

The last row is the one a reader should carry away: on a single model, with 5 runs, most of these differences are below the noise floor. The measurements that are exact — filter bytes, prompt overhead — are the ones worth quoting.

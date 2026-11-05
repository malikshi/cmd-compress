# Measured results

Measured 2026-11-04. Model `nexrouter/deepseek-v4.1-flash`, Command Code `1.88.2`, rtk `1.1.0`, Linux.

The shell-output rows were re-measured after the local condenser was added: the mod no longer sends a grep body or a path list to `rtk pipe` first. Both are grouped in-process, which raised every grep and glob row and removed the process spawn (0–1 ms instead of 12–15 ms). rtk is still the filter for everything the local pass declines.

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
| grep, clustered | 240 matches in 6 files | 16,130 | 1,377 | **91.5%** | 6/6 files named, 240 of 240 match lines kept |
| grep, scattered | 240 matches in 240 files | 14,874 | 13,421 | **9.8%** | 240/240 files named |
| find | 260 paths in 10 dirs | 6,092 | 1,149 | **81.1%** | 10/10 dirs named, header correct |

### Command Code's own tool shapes

The raw rows above are rtk's fixture, not what this host produces. A `glob` result opens with `Found N files`, a truncated `glob` closes with `(Results are truncated: showing 1-100 of 382 matches …)`, a truncated `grep` closes with `[Showing results with pagination = …]` or `Found N total occurrences across M files …`, and `shell_command` opens with the exit status and may close with `Command aborted` or `Command timed out after …`. These rows run the mod's real split → filter → re-attach path, and the fidelity column asserts the envelope survived.

| Case | Envelope | Bytes in | Bytes out | Saved | Fidelity |
|---|---|---:|---:|---:|---|
| glob tool | `Found 260 files` header | 4,326 | 788 | **81.8%** | header kept, local path condenser |
| glob tool, truncated | header + truncation notice | 5,021 | 964 | **80.8%** | header kept, trailer kept |
| grep tool, truncated | pagination notice | 15,540 | 1,333 | **91.4%** | trailer kept, local row condenser |
| grep tool, files mode | `Found 300 files …` header | 4,448 | 439 | **90.1%** | header kept, local path condenser |
| grep tool, count mode | total-occurrences notice | 722 | 231 | **68.0%** | trailer kept, local count condenser |
| shell tool | `Exit code: 1` head | 2,769 | 324 | **88.3%** | header kept |
| shell tool, timed out | header + timeout notice | 5,889 | 339 | **94.2%** | header kept, trailer kept |
| shell tool, declined grep baseline | none — rtk refused to group | 8,081 | 430 | **94.7%** | local row condenser |
| shell tool, coloured build | `Exit code: 2` head + 40 SGR-coloured `tsc` errors | 5,274 | 3,474 | **34.1%** | header kept |

### The declined baseline

rtk's search filter prints its **faithful baseline** whenever capping would not shrink the output. That is the normal case for a multi-file grep: `grep -rn export mods` measured 4,026 → 4,026 bytes through `rtk grep`, so a command rtk rewrote still reached the model at full size. The mod now recognises that baseline — no recovery marker, and a majority of `path:line:text` rows — and runs one more filter pass over it.

| Command | rtk grep | After 2nd pass | Recovered |
|---|---:|---:|---:|
| `grep -rn export mods` | 4,206 | 2,691 | **36.0%** |
| `grep -rn function mods` | 3,723 | 2,475 | **33.5%** |
| `grep -rn Rules: …/contract` | 1,984 | 1,325 | **33.2%** |
| `rtk grep -rn export mods` | 4,206 | 2,691 | **36.0%** |

The gate has to exist because the opposite is destructive: one blind second pass over rtk-grouped output **deleted all 9 `rtk recall` hints** from it, and a recall hash is unrecoverable once its hint is gone. So anything carrying `matches in N files:`, `+N more`, `+ … more files`, `[+N hidden: rtk recall …]` or `[full output: rtk recall …]` is left byte-identical to what rtk emitted.

Cost is bounded: the local pass costs no process at all (0–1 ms), and it is skipped below the 1,200-byte threshold and for every non-match-list shape. The old second `rtk pipe` pass, which this replaces on the row path, measured **12 ms** median. Twelve real rewritten commands (`git status`, `git log`, `git diff`, `npm test`, `npx tsc`, `ls`, `find`, `git branch`, `du`) measured **0 bytes changed** — the gate does not fire on them at all.

A live headless run against a fixture repo confirms it outside the bench: a `glob` of 380 files came back as `Found 100 files` plus rtk's grouped body and the host's own truncation notice intact — **1,771 → 471 bytes**, every directory named.

Those rows exist because an earlier build lost or skipped every one of them. Each was found by reading the host's own formatter and the real binary's output, not by guessing:

- The `find` filter read `Found N files` as a path, the `grep` filter folded the pagination notice away as noise, and the shell pass folded away `Exit code: 1`. Fixed by filtering only the body and re-attaching the host's envelope verbatim.
- The truncation notice was a second discovery: the first fix guessed at `[…]` when the host prints `(Results are truncated: showing 1-100 of 382 matches …)`.
- **Count mode, the timeout notice, the cwd note and the edition banner were still being folded away.** `rtk pipe` dropped `Found N total occurrences across M files …`, `[Search timed out — …]`, `Command timed out after 120000ms (exit code 124). …`, `[cwd change to …]` and `[PowerShell edition: …]`, and the mod's trailer regex matched none of them — measured, the whole tail vanished from the model's view.
- **The interpreted exit code was lost.** `formatResult2` writes `(No matches found)` on its own line under `Exit code: 1`; that line went into the body and was folded.
- **`grep`'s default mode compressed nothing.** The tool defaults to `files_with_matches`, a path list under a `Found N files` header. The mod forced `-f grep`, which returns that shape byte-identical (4,448 → 4,448); the shape now selects the find filter instead (→ 620).

- **Colour survived every filter, and the host's spill pointer did not.** `rtk pipe` returns every ANSI escape intact: 10,110 bytes of coloured test output came back at 10,110 bytes with 720 escapes still in it, while the escape-free text is 6,750 bytes. The strip is now unconditional and measured at **34.1%** on a 40-error `tsc` shape. Separately, a result the host truncated in the middle carries `[... output truncated: …]` and `[full output saved to: …]` there — measured, rtk deleted both when it compressed a 2,951-byte pytest result down to 296 bytes, so the pointer is now lifted out and re-attached.
- **rtk's auto-detect can destroy a build failure.** Its `never_worse` guard only compares sizes. A cargo-shaped block of twenty `error[E0xx]: cannot find value …` lines (1,919 bytes) came back as 156 bytes of grep grouping — `20 matches in 1F: [file] --> src/lib.rs (20): 0: 5 1: 5 …` — with every error message gone and no recovery hint. That is a wrong format guess, not compression. A format-shaped fidelity guard now refuses a grouping whose input was neither a match list nor a path list, and refuses any result that dropped a negation; the original then reaches the model unchanged.

Rewrite: 12 of 12 commands rewritten, ~78 ms mean, ~84 ms p95.

**The scattered row is the honest floor.** 240 matches across 240 files saves 9.8%, because a per-file row cannot be dropped without dropping the file. Reporting only the clustered case would have claimed 91% as if it were universal. The claim is *"a shell result that groups by file gets much smaller; a result with one hit per file still moves, but only a little."* Before the local condenser this row was **0.0%** — rtk's `never_worse` guard refused the regrouping outright.

**Why the local pass exists.** rtk's own grep filter groups by file but repeats the full path and match text on every row, so on a hit-dense file it barely moves: a body of 20 files × 5 hits came back 6,850 → 6,591 (**3%**), 30 files × 1 hit came back 1,671 → 1,671 (**0%**), and a 400-row count-mode body 17,140 → 14,331 (**16%**). The mod's in-process condenser groups *and* dedupes — identical lines collapse to one row with their line numbers joined — and lands at **77%** on the 20-files × 5-hits body. Two layouts are built and the smaller wins: `[file] path (N):` blocks for a file with several hits, and a `dir/  (N)` tree of `name:numbers:text` rows for a body that is mostly one hit per file — the layout that takes the 240-files-one-hit case from 0% to 9.8%. A one-hit-per-file body is shape-dependent rather than a fixed win: 5–7% inside a single shallow directory (below the 5% floor only marginally, so it is left alone), 15–23% across several directories, 41% under one deep shared prefix. It runs in 0 ms: no process, no temp file, and it works with no rtk installed at all. rtk's `find` filter loses whole directories on a wide tree (19 of 60 named on one measured glob), which the local path pass does not.

**Count mode has its own pass.** The host's `finishCountMode` emits `path:count`, not content rows — one row per file with the number of matches. The row condenser cannot parse it (it needs a third field) and the path condenser must not: reading `src/file0.ts:1` as a path with line `1` is wrong, because `1` is that file's match count. `condenseCountRows` groups the shape with every number labelled — `dir/  (N files, M hits)` and `name (count)` rows — so nothing can be mistaken for a line number. Measured: the 40-file body alone **77.4%** (633 → 143), and **68.0%** (722 → 231) with the total-occurrences trailer re-attached. Through rtk alone this shape is unchanged (measured 634 → 634 with `-f grep`; `-f find` saves 73% but prints the count with no label at all).

**Fidelity has a cost.** Clustered grep keeps every file name but caps the distinct lines shown per file at six, folding each file's tail behind `+N more lines in this file`. Fewer bytes, every named file still present, but a grep result where those folded lines mattered will read worse, not better.

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
| Shell output gets smaller | **Conditionally, exactly measured.** 91.5% on file-clustered grep, 81.1% on `find`, **9.8%** when hits are one-per-file. |
| A mode adds prompt overhead | **Yes, reproducible.** Within 10% of the static estimate for a single mode; presets read ~20% above it. |
| Caveman shortens replies | **Only `ultra`, by ~12–13%**, and only on open prompts. `full` costs more in both runs. |
| The mode pays for itself in one turn | **No.** `ultra` saves ~50–70 reply tokens against a 232-token block. |
| Ponytail produces leaner code | **Not measured.** Reply tokens cannot show it; needs a test/review gate. |
| Any dollar saving | **Not claimed.** No price table, no bill figure. |
| This bench can rank modes to ±10% | **No.** Only 4 of 9 deltas kept their sign across two runs. |

The last row is the one a reader should carry away: on a single model, with 5 runs, most of these differences are below the noise floor. The measurements that are exact — filter bytes, prompt overhead — are the ones worth quoting.

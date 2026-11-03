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

The raw rows above are rtk's fixture, not what this host produces. A `glob` result opens with `Found N files`, a truncated `glob` closes with `(Results are truncated: showing 1-100 of 382 matches …)`, a truncated `grep` closes with `[Showing results with pagination = …]`, and `shell_command` opens with the exit status. These rows run the mod's real split → filter → re-attach path, and the fidelity column asserts the envelope survived.

| Case | Envelope | Bytes in | Bytes out | Saved | Fidelity |
|---|---|---:|---:|---:|---|
| glob tool | `Found 260 files` header | 4,326 | 1,149 | **73.4%** | header kept |
| glob tool, truncated | header + truncation notice | 5,021 | 1,345 | **73.2%** | header kept, trailer kept |
| grep tool, truncated | pagination notice | 15,540 | 3,183 | **79.5%** | trailer kept |
| shell tool | `Exit code: 1` head | 2,769 | 324 | **88.3%** | header kept |

A live headless run against a fixture repo confirms it outside the bench: a `glob` of 380 files came back as `Found 100 files` plus rtk's grouped body and the host's own truncation notice intact — **1,771 → 471 bytes**, every directory named.

Those four rows exist because an earlier build lost every one of them: the `find` filter read `Found N files` as a path, the `grep` filter folded the pagination notice away as noise, and the shell pass folded away `Exit code: 1`. All three were measured, then fixed by filtering only the body and re-attaching the host's envelope verbatim. The truncation notice itself was the second discovery: the first fix guessed at `[…]` when the host actually prints `(Results are truncated: showing 1-100 of 382 matches …)`, caught by reading a real result instead of the source.

Rewrite: 12 of 12 commands rewritten, ~77 ms mean, ~82 ms p95.

**The scattered row is the important one.** It saves nothing, and that is not a bug: rtk's `never_worse` guard refuses a regrouping larger than its input. Reporting only the clustered case would have claimed 80% as if it were universal. The honest claim is *"a shell result that groups by file gets much smaller; a result with one hit per file is unchanged."*

**Fidelity has a cost.** Clustered grep keeps 60 of 240 match lines — it folds each file's tail behind `+N`. Fewer bytes, fewer lines, every named file still present. A grep result where those folded lines mattered will read worse, not better.

## 2. Prompt overhead — the one solid live result

The block a mode injects is measured twice: statically (chars/4 of the rules text) and live (input tokens against base). Measured on the open surface, which is stable across both runs because it does not depend on the model's reply.

| Case | Live overhead | Static estimate | Ratio |
|---|---:|---:|---:|
| control | +5 to +35 | ~7 | — |
| caveman lite | +150 | ~137 | 1.09 |
| caveman full | +455 to +457 | ~465 | 0.98 |
| caveman ultra | +232 | ~239 | 0.97 |
| caveman megacave-full | +281 | ~257 | 1.09 |
| ponytail full | +536 | ~600 | 0.90 |
| ponytail ultra | +552 | ~618 | 0.90 |
| compress balanced | +1,220 to +1,247 | ~1,065 | 1.17 |
| compress max | +1,009 to +1,040 | ~857 | 1.21 |

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

**Paradox worth stating:** richer instructions make this model write more. Caveman's blocks are *instructions about style*, and this model appears to treat a longer style brief as licence for a longer answer. `ultra` is the shortest block (953 bytes) and the only one that saved — consistent with that explanation, though two runs cannot prove it.

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

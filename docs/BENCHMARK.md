# Benchmark

How to measure `cmd-compress`, with no number quoted that this repository did not measure.

Two halves, both runnable:

| Half | Command | What it measures | Reproducible? |
|---|---|---|---|
| **Command output** | `npm run bench` | rtk filter byte reduction, rewrite latency, prompt block size | **Yes.** Byte ratios are exact. |
| **Live prompt** | `npm run bench:prompt` | Reply tokens per mode against base, from real session usage | **Depends on the model.** |

The split matters. Command output is deterministic: the same fixture and the same rtk binary produce the same bytes on any machine. Reply tokens depend on the model, the temperature, and the day, so that half reports medians and a run count, never a single sample.

## 1. Command output bench

```bash
npm run bench
```

It writes `bench/results/output.md`. No API key, no model, no cost.

### What it does

1. **Filters.** Builds three deterministic fixtures from a fixed seed and pipes each through `rtk pipe -f <filter>`, five times, keeping the median time and the byte counts.
2. **Rewrite.** Runs `rtk rewrite` over 12 commands a coding agent actually runs, and reports how many got a rewrite plus mean and p95 latency.
3. **Prompt overhead.** Measures the exact byte size of every level's injected block and estimates its tokens at chars/4.

### Fixture shapes

grep is measured in two shapes on purpose:

| Shape | Layout | What it shows |
|---|---|---|
| **clustered** | 240 matches across 6 files | The common case: rtk groups by file and folds the tail of each. |
| **scattered** | 240 matches across 240 files | One hit per file. rtk's `never_worse` guard refuses a regrouping larger than its input, so this can be 0%. |

A single grep fixture would hide half the behaviour. The scattered row is the reason the guide says "byte ratios, not guarantees".

### Fidelity, not just size

A filter that drops the failing line is worse than no filter. Each row carries a fidelity verdict:

- **grep**: how many input files are named in the output, and how many match lines survive.
- **find**: how many input dirs are named, and whether the header's own file/dir counts are correct.

The bench prints `passed through unchanged` when rtk declines to filter. That is a result, not a failure.

### If rtk is missing

The filter and rewrite rows print `unmeasured: rtk not installed`. They are left blank, never filled with a zero that would read as a measured saving.

## 2. Live prompt bench

```bash
npm run bench:prompt -- 3                 # 3 runs per prompt per case, session default model
npm run bench:prompt -- 3 nexrouter/deepseek-v4.1-flash
```

It writes `bench/results/prompt.md`. **This spends real tokens**: each case is `runs × 6` headless sessions, and the default matrix is 10 cases.

### What it measures

Each case runs the same fixed prompts in a **fresh headless process**, with `--output-format json`, and reads the token counts from the session's own usage frame — not an estimate.

| Case | Modes set |
|---|---|
| `base` | none — the reference every delta is against |
| `control` | the instruction `Answer concisely.` |
| `caveman lite` / `full` / `ultra` / `megacave-full` | one level |
| `ponytail full` / `ultra` | one level |
| `compress balanced` / `max` | the preset |

**The control case is not optional.** Caveman's goal is "shorter", and so is the instruction "Answer concisely." Without the control, a shorter reply cannot be attributed to caveman rather than to the prompt already asking for brevity. Tersio's guide makes the same point, and this bench follows it.

### The prompts, in three surfaces

Fixed, so two people measure the same thing. Three surfaces, because one prompt shape cannot answer the question on its own:

| Surface | Prompts | Shape | What a delta means |
|---|---|---|---|
| **Open prose** | O1–O3 | The question alone, no length asked for | The fair test of a brevity mode — the answer length is the model's choice |
| **Pinned prose** | P1–P3 | Each asks for "three sentences" | The reply size is fixed by the prompt, so a delta here is **noise**, not the mode |
| **Code** | C1–C3 | Named TypeScript functions, code only | Reply size is mostly the code the answer needs |

**Why open prose is the headline row.** A prompt that says "in three sentences" fixes the answer length for every mode, so any difference is model noise. Measuring only that surface would produce a table full of deltas that mean nothing. Every surface is still reported — side by side — because the contrast is the finding: the same model under the same mode can look faster on a pinned prompt and slower on an open one.

**One deliberate deviation from tersio's prompt text.** The code prompts end with *"Reply with the code only; do not read, create, or edit any file."* Without it the model explores the repository first and the run ends at `max-turns` (exit 8), so the sample is lost. This surface measures **reply size**, not the repo-exploration path, so forbidding tool use is what makes the measurement well-defined. The `--max-turns` budget is 6 and a max-turns run is reported as a failure, never folded into a median.

Quality gate:

- **Prose**: the required keyword groups — a lexical substring test, stated as a floor, not a judge.
- **Code**: the requested function names appear in the reply.

### Metrics

| Column | Meaning |
|---|---|
| Reply median | Median model-output tokens across the case's runs |
| Δ Tokens | Reply median − base reply median. Negative is a saving |
| Δ% | Δ ÷ base median |
| Input median | Median input tokens, which include the mode's block on every turn |
| Quality | Passing runs / total runs, or `partial (n/total)` |

Read Δ Tokens beside **Input median**. A mode can cut reply tokens and still cost more overall, because its block is re-sent on every single turn. The block is roughly 140–620 estimated tokens depending on level (section 1, prompt overhead), so on a one-turn question a heavy mode is close to break-even, and it pays off only over a longer session.

### Reporting rules

- **Partial is labelled.** A case with fewer runs than requested prints `partial (n/total)`, never a clean median.
- **Failures are kept.** A run that errors or times out is counted as a missing run, not silently dropped into a smaller sample.
- **No savings claim below base quality.** If a mode's pass rate is under base's, its Δ is not a win.

## 3. What this bench does not measure

- **Ponytail's effect on code quality.** It changes what the model writes, and judging that needs a test suite and a review, not a token count. The reply-token row only shows what the rule block costs.
- **Total bill.** Prices change per model and provider; this repository states no dollar figure.
- **Cache behaviour.** A byte-stable block survives the provider's prompt-prefix cache, but whether a given provider caches is outside this bench.
- **Agentic task success.** Whether rtk's condensed test output still lets the model fix a bug is a real question; it needs a fixture repo with an injected failure and a pass-rate gate. Tersio's guide describes that protocol in full and this repository does not claim its numbers.

## 4. Reproducing a result

```bash
git checkout <the commit you measured>
npm test                      # the mods must pass before their numbers mean anything
npm run bench                 # exact half — same bytes on any machine with the same rtk
npm run bench -- 3 <model-id> # live half — record the model id in the result file
```

Record the rtk version (`rtk --version`) and the Command Code version (`cmd --version`) beside any result you publish. A result without both is not reproducible.

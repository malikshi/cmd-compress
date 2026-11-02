# Live prompt benchmark — run B

Measured: 2026-11-02T23:23:12.816Z
Model: nexrouter/deepseek-v4.1-flash
Runs per case: 5 × 9 prompts = 45

> This is the **second** of two runs on the same day, same model, same prompts. The first is `prompt-run-a.md`. They disagree on most cases — see `docs/BENCHMARK-RESULTS.md` §2.

Every case ran in a fresh headless process with the same prompts. Reply tokens are the model-output count from the session usage, not an estimate. Reported per surface, because a length-pinned prompt cannot show a brevity effect.

## Open prose (O1–O3)

The answer length is the model's choice, so this is the fair test of a brevity mode.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 525 | 0 | 0% | 28069 | 15/15 |
| control | 15 | 414 | -111 | -21.1% | 28074 | 15/15 |
| caveman lite | 15 | 441 | -84 | -16.0% | 28220 | 15/15 |
| caveman full | 15 | 575 | 50 | 9.5% | 28524 | 15/15 |
| caveman ultra | 15 | 456 | -69 | -13.1% | 28301 | 15/15 |
| caveman megacave-full | 14 | 833 | 308 | 58.7% | 28351 | partial (14/15) |
| ponytail full | 15 | 459 | -66 | -12.6% | 28605 | 15/15 |
| ponytail ultra | 15 | 395 | -130 | -24.8% | 28621 | 15/15 |
| compress balanced | 15 | 501 | -24 | -4.6% | 29289 | 15/15 |
| compress max | 15 | 489 | -36 | -6.9% | 29078 | 15/15 |

Base reference: reply median 525, input median 28069, quality 15/15.

## Pinned prose (P1–P3)

Each prompt asks for "three sentences", so the reply size is fixed by the prompt and a delta here measures noise, not the mode.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 112 | 0 | 0% | 28070 | 9/15 |
| control | 14 | 96 | -17 | -14.7% | 28104 | partial (14/15) |
| caveman lite | 15 | 98 | -14 | -12.5% | 28250 | 10/15 |
| caveman full | 15 | 107 | -5 | -4.5% | 28555 | 9/15 |
| caveman ultra | 14 | 110 | -2 | -1.8% | 28330 | partial (14/15) |
| caveman megacave-full | 15 | 263 | 151 | 134.8% | 28381 | 3/15 |
| ponytail full | 15 | 114 | 2 | 1.8% | 28608 | 8/15 |
| ponytail ultra | 15 | 143 | 31 | 27.7% | 28623 | 9/15 |
| compress balanced | 15 | 97 | -15 | -13.4% | 29293 | 7/15 |
| compress max | 15 | 115 | 3 | 2.7% | 29081 | 9/15 |

Base reference: reply median 112, input median 28070, quality 9/15.

## Code (C1–C3)

Function names are fixed and the prompt asks for code only, so reply size is mostly the code the answer needs.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 362 | 0 | 0% | 28124 | 15/15 |
| control | 15 | 293 | -69 | -19.1% | 28131 | 15/15 |
| caveman lite | 15 | 508 | 146 | 40.3% | 28277 | 15/15 |
| caveman full | 15 | 354 | -8 | -2.2% | 28579 | 15/15 |
| caveman ultra | 14 | 331 | -32 | -8.7% | 28356 | partial (14/15) |
| caveman megacave-full | 15 | 463 | 101 | 27.9% | 28409 | 15/15 |
| ponytail full | 15 | 457 | 95 | 26.2% | 28661 | 15/15 |
| ponytail ultra | 15 | 496 | 134 | 37.0% | 28677 | 15/15 |
| compress balanced | 15 | 541 | 179 | 49.4% | 29347 | 15/15 |
| compress max | 15 | 541 | 179 | 49.4% | 29134 | 15/15 |

Base reference: reply median 362, input median 28124, quality 15/15.

**Failed runs, excluded from the medians:** exit-1: 4.

Read Δ Tokens beside Input median. A mode can cut reply tokens and still add tokens overall, because its block is re-sent every turn.

**This table is incomplete.** A case short of its run count is a partial sample, so its median is not a clean result.


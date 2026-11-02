# Live prompt benchmark — run A

Measured: 2026-11-02T18:46:48.187Z
Model: nexrouter/deepseek-v4.1-flash
Runs per case: 5 × 9 prompts = 45

Every case ran in a fresh headless process with the same prompts. Reply tokens are the model-output count from the session usage, not an estimate. Reported per surface, because a length-pinned prompt cannot show a brevity effect.

> This is the **first** of two runs on the same day, same model, same prompts. The second is `prompt-run-b.md`. They disagree on most cases — see `docs/BENCHMARK-RESULTS.md` §2.

## Open prose (O1–O3)

The answer length is the model's choice, so this is the fair test of a brevity mode.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 407 | 0 | 0% | 28069 | 15/15 |
| control | 15 | 401 | -6 | -1.5% | 28104 | 14/15 |
| caveman lite | 15 | 460 | 53 | 13.0% | 28219 | 15/15 |
| caveman full | 15 | 535 | 128 | 31.4% | 28526 | 15/15 |
| caveman ultra | 15 | 358 | -49 | -12.0% | 28301 | 15/15 |
| caveman megacave-full | 15 | 715 | 308 | 75.7% | 28350 | 4/15 |
| ponytail full | 15 | 519 | 112 | 27.5% | 28607 | 15/15 |
| ponytail ultra | 15 | 425 | 18 | 4.4% | 28623 | 15/15 |
| compress balanced | 15 | 421 | 14 | 3.4% | 29316 | 15/15 |
| compress max | 15 | 410 | 3 | 0.7% | 29109 | 15/15 |

Base reference: reply median 407, input median 28069, quality 15/15.

## Pinned prose (P1–P3)

Each prompt asks for "three sentences", so the reply size is fixed by the prompt and a delta here measures noise, not the mode.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 112 | 0 | 0% | 28072 | 10/15 |
| control | 15 | 114 | 2 | 1.8% | 28080 | 8/15 |
| caveman lite | 15 | 104 | -8 | -7.1% | 28249 | 9/15 |
| caveman full | 15 | 96 | -16 | -14.3% | 28554 | 9/15 |
| caveman ultra | 15 | 119 | 7 | 6.3% | 28300 | 12/15 |
| caveman megacave-full | 15 | 238 | 126 | 112.5% | 28349 | 2/15 |
| ponytail full | 15 | 114 | 2 | 1.8% | 28607 | 12/15 |
| ponytail ultra | 15 | 115 | 3 | 2.7% | 28622 | 7/15 |
| compress balanced | 15 | 104 | -8 | -7.1% | 29320 | 8/15 |
| compress max | 15 | 117 | 5 | 4.5% | 29111 | 8/15 |

Base reference: reply median 112, input median 28072, quality 10/15.

## Code (C1–C3)

Function names are fixed and the prompt asks for code only, so reply size is mostly the code the answer needs.

| Case | Runs | Reply median | Δ Tokens | Δ% | Input median | Quality |
|---|---:|---:|---:|---:|---:|---|
| base | 15 | 460 | 0 | 0% | 28124 | 15/15 |
| control | 15 | 328 | -132 | -28.7% | 28146 | 15/15 |
| caveman lite | 15 | 350 | -110 | -23.9% | 28274 | 15/15 |
| caveman full | 15 | 476 | 16 | 3.5% | 28579 | 15/15 |
| caveman ultra | 15 | 407 | -53 | -11.5% | 28355 | 15/15 |
| caveman megacave-full | 15 | 618 | 158 | 34.3% | 28405 | 15/15 |
| ponytail full | 15 | 523 | 63 | 13.7% | 28663 | 15/15 |
| ponytail ultra | 15 | 340 | -120 | -26.1% | 28706 | 15/15 |
| compress balanced | 15 | 490 | 30 | 6.5% | 29376 | 15/15 |
| compress max | 14 | 463 | 3 | 0.7% | 29152 | partial (14/15) |

Base reference: reply median 460, input median 28124, quality 15/15.

**Failed runs, excluded from the medians:** exit-1: 1.

Read Δ Tokens beside Input median. A mode can cut reply tokens and still add tokens overall, because its block is re-sent every turn.

**Note on this run's megacave quality row (4/15).** The gate at the time checked English keywords only, so a correct Classical Chinese answer scored as a failure. The gate is now bilingual; run B measured it as 14/15.

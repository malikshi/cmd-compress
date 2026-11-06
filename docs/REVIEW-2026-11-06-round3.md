# Review — cmd-compress production readiness (2026-11-06, round 3)

Baseline: `07a2e0b`, clean tree. Scope: the four mods, `mods/shared.ts`, `mods/rtk-local.ts`,
`mods/rtk-cli.ts`, `rules/*`, `scripts/verify-mods.ts`, `types/harness.d.ts`.
Method: read every source file, ran the suite, bench, and CodeDNA checker, drove a real
Command Code 1.88.4 host with a stub `rtk` and a probe mod to capture real tool-result
bytes, then fuzzed the parsers with adversarial input.

## Verdict

APPROVE after the fix below. One HIGH found and fixed. Everything else checked holds.

## Findings

| ID | Severity | Location | Finding | Status |
|---|---|---|---|---|
| F1 | HIGH | `mods/rtk-local.ts` `condensePaths` | The per-directory cap was applied unconditionally, so a directory just over the cap lost names to a layout that could be **larger** than the uncapped one. Measured: seven `./src/d0/xN.ts` paths returned 93 bytes with `x6.ts` dropped, where the uncapped tree was 90 bytes with every name. | fixed |
| F2 | MEDIUM | `mods/rtk-local.ts` `condensePaths` / `condenseCountRows` | An exact byte tie kept the capped layout, dropping a name for zero gain. Measured in `condensePaths`: seven `./src/widgets/nnnN.ts` paths, 116 bytes either way. Measured in `condenseCountRows`: seven 4-character names under a 10-character directory, 130 bytes either way, because `  g.ts (1)` and `  +1 files` are both ten characters. | fixed — uncapped rendering is passed first |
| F3 | LOW | `mods/rtk-local.ts` `condensePaths` | Building both layouts on every call doubles allocation on the common shape where no directory overflows. Measured on 900 paths / 150 dirs × 6: 431 KB and 1.04 ms for one rendering vs 670 KB and 1.20 ms for two. | fixed — capped rendering built only when a directory overflows |
| F4 | LOW | `test/rtk-shapes.test.ts` | Two new assertions weakened by `continue` on null and by requiring a non-null uncapped layout, which the 5% floor can legitimately reject. | fixed |
| F5 | LOW | `test/rtk-shapes.test.ts` | A count-floor test whose fixture had a layout *larger* than its input, so it proved nothing about the floor. Replaced with a body that shrinks 4.8% and is still declined. | fixed |

## Rejected as non-defects (checked, no change)

| Candidate | Why it is not a defect |
|---|---|
| `pinBinary` leaves `rtk` bare inside a subshell (`(rtk …)`, `if rtk …`) | rtk 1.1.0 answers exit 1 for every one of those forms — verified against the real binary for `( )`, `if/then`, `while`, `for`, `case`, `{ }`, `!`, `sudo`, `x=$(…)`. It never emits them, so the gap is unreachable. |
| `api.md` says the sub-agent tool is `task` | The bundled host registers `name:"agent"`; `AGENT_TOOL` is correct. The reference doc is the stale one. |
| Single-file `-A/-B/-C` grep context could be regrouped and lose context | Verified against real `rg` output: both `condenseGrepRows` and `condensePaths` refuse it, and `checkFidelity` reports ok. No loss. |
| `condenseGrepRows` at 40k rows takes 509 ms | The host truncates inline output at 30,000 chars, so that body is unreachable in a session. At the real 30k ceiling the median is 1.2 ms. |
| A ~500 ms outlier in condenser timings | One iteration in 400, on bodies whose median is 1.2 ms — a GC pause, not an algorithmic cost. p99 is 3 ms. |
| `compress.ts` calls `paint()` at factory time | It reads siblings through `cmd.use`, which answers undefined until they load, so the first paint is a no-op rather than a stale value; `onSessionStart` repaints. |
| `ruleStamp()` costs ~1 ms per repeated command | Real, but it is deliberate: it is the cost that keeps a cached rewrite from bypassing a rule edited mid-session. Measured here at 0.2–0.3 ms median, p95 0.7 ms (11 `statSync` from a three-level path, 62 from twenty levels), against the 30–160 ms spawn it avoids. The README previously claimed 1 ms shallow and 4–6 ms deep; corrected to the measured range. |

## Verified against the real host (Command Code 1.88.4)

- `beforeToolCall` rewrite fires: stub log shows `--version`, then `rewrite git status --short`.
- ANSI strip reaches the model: a `printf '\033[31mRED\033[0m'` result arrived as `RED`.
- Real tool-result shapes captured through a probe mod and replayed through the production
  condense path: grep content mode 3,887 → 2,484 bytes (36.1%) with the pagination trailer
  kept; glob with `Found 7 files` header kept.
- Host truncation shape confirmed: the pointer is a two-line block in the middle of a
  30k result, exactly as `extractSpillNotices` expects.

## Checks

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | 257 tests, 256 pass, 1 skipped (cmd.exe path, Windows-only), 0 fail |
| `npm run verify` | exit 0; all four factories load |
| `npm run bench` | byte ratios identical to the committed results |
| CodeDNA checker, `mods/` | 0 findings |
| CodeDNA checker, `test/` | 10 findings, all pre-existing (long test titles); identical count with the diff stashed |
| New tests against pre-fix code | all 3 fail; pass after the fix |

## Residual risk

- The two condensers still choose capped-vs-uncapped **globally**, not per directory, so a
  body mixing one overflowing directory with a short one can charge the short directory a
  name. Measured at 7 bytes on a synthetic mixed body; not worth per-directory bookkeeping.
- Windows paths remain exercised by CI and by unit tests rather than by a real `cmd.exe`
  run here; the `windows-latest` job is the only real proof.
- The live benchmark cannot rank modes tightly (documented in the README); nothing here
  changes that.

# cmd-compress

Token compression mods for [Command Code](https://commandcode.ai/docs/mods): shorter replies, leaner code, smaller shell output. Four mods, one package.

| Mode | What it changes | Command |
|---|---|---|
| **caveman** | The reply voice. Answer first, filler gone, every technical fact kept. | `/caveman [lite\|full\|ultra\|megacave-*\|off]` |
| **ponytail** | The code you write. Smallest change that fully works; nothing unrequested. | `/ponytail [lite\|full\|ultra\|off]` |
| **rtk** | Shell output. Rewrites `shell_command` through `rtk rewrite`, condenses output no rewrite covered, and filters grep/glob results. | `/rtk [on\|off\|status\|gain]` |
| **compress** | All three at once, at one of four presets. | `/compress [off\|lite\|balanced\|max\|status]` |

Every mode is **off by default**. Nothing changes until you turn it on, and the choice persists across sessions in `~/.commandcode/mods/.store/`.

## Install

```bash
cmd mods add owner/cmd-compress          # GitHub
cmd mods add ./cmd-compress              # a local checkout
cmd mods add cmd-compress                # npm, once published
```

Or try it in one session without installing:

```bash
cmd --mod ./mods/caveman.ts --mod ./mods/ponytail.ts \
    --mod ./mods/rtk.ts --mod ./mods/compress.ts
```

Reload after an edit with `/reload`. The mods are watched in the TUI: saving the file swaps it in place.

## Use

```
/compress balanced     caveman=full, ponytail=full, rtk=on
/compress max          caveman=ultra, ponytail=ultra, rtk=on
/compress off          all three off
/compress status       what is on right now
```

Set one mode on its own when a preset is too blunt:

```
/caveman lite          trim ceremony only
/caveman megacave-full 文言 register
/ponytail ultra        also question the request
/rtk on                rewrite shell commands through rtk
/rtk off
```

Or say `stop caveman` / `stop ponytail` as the whole message. `normal mode` — the phrase both upstream projects use — turns every mode off at once, `rtk` included. An ordinary sentence that merely mentions the mode does not disable it.

### Presets

| Preset | caveman | ponytail | rtk |
|---|---|---|---|
| `off` | off | off | off |
| `lite` | lite | lite | on |
| `balanced` | full | full | on |
| `max` | ultra | ultra | on |

`rtk` is binary — it is either rewriting or it is not — so every live preset turns it on.

### Caveman levels

`lite` trims ceremony only. `full` adds fragments, payload-verbatim, and the bounded-status rule. `ultra` compresses to tables and single clauses. The three `megacave-*` levels use a Classical Chinese register with technical terms kept verbatim.

Every level keeps the same floor: code, commands, paths, numbers, and errors verbatim, every negation intact, and plain prose for a security warning, an irreversible action, or a confused user.

### Ponytail levels

`lite` builds what was asked and names the smaller option. `full` adds the smallest-change ladder and the never-cut list. `ultra` also pushes back on parts of the request the need does not justify.

Every reply ends with one or two lines: what was skipped, and any risk.

## RTK

`rtk` mode shells out to the [RTK](https://github.com/rtk-ai/rtk) binary. Install it first:

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh
```

`/rtk status` reports whether the binary was found and which version it is. When rtk is active:

- **`shell_command` is rewritten** through `rtk rewrite` before it runs, so `git status` executes as `rtk git status`. The full documented exit-code contract is honoured: `0` and `3` carry a rewrite, `1` means no equivalent, and `2` is a deny — a `2` that prints a reason becomes a block carrying that reason, while a silent `2` is a host deny rule rtk only relays and is left to the host to enforce. The emitted `rtk` is **pinned to the absolute path** this mod resolved, because rtk is often installed under `~/.bun/bin`, which the shell may not have on `PATH` — a bare name there would fail as `rtk: not found`.
- **Shell output with no rewrite is still condensed.** `npm test`, `awk`, and `sed` have no rtk equivalent, yet their output can be cargo-test or pytest shaped. Above 1200 bytes it goes through `rtk pipe` with no `-f`, which auto-detects the format and passes the text through unchanged when nothing matches. A call that *was* rewritten is skipped, since rtk already filtered it.
- **`grep` and `glob` results are condensed** above 1200 bytes, through `rtk pipe -f grep|find`.
- **The host's own envelope is never filtered.** A `glob` result opens with `Found N files`; a truncated `grep` closes with `[Showing results with pagination = …]`; `shell_command` opens with `Exit code: 1`. Those lines carry meaning — the count, that the list is truncated, that the command failed — and rtk folds them away as noise. The mod splits them off before the filter and re-attaches them verbatim after it, so only the body is ever condensed.
- **Every failure passes through.** A missing binary, an abort, a non-zero exit from the filter, or a result that came back larger than the original leaves the original untouched. No rtk call can hang a tool call: `cmd.exec` ignores a `timeout` option, so each one runs under an `AbortController`.
- **A failed tool result is never filtered** — the error text reaches the model intact.
- **A binary older than 0.23.0 turns rewrites off** instead of silently doing nothing, since that is the version `rtk rewrite` shipped in.

`/rtk gain` reads `rtk gain -f json` and reports the token savings rtk itself recorded, so the claim is measured rather than estimated:

```bash
/rtk status   # RTK: on (binary: 1.0.1)
/rtk gain     # RTK saved 2,024,857 tokens over 10,601 commands (40.9%).
```

Turn the grep/glob filter off but keep the rewrite, or turn off the extra shell pass:

```bash
cmd --mod-option rtk-filter=false
cmd --mod-option rtk-shell=false
```

## Flags

Each mod takes a per-session starting mode, applied when the session binds:

```bash
cmd --mod-option caveman=full --mod-option ponytail=ultra --mod-option rtk=on
cmd --mod-option rtk-filter=false
cmd --mod-option rtk-shell=false
```

A flag beats the stored value for that session. It does not overwrite the store.

## How it works

Each mod is one file, default-exporting a factory that registers a slash command, a flag, and its hooks:

| Mod | Hooks |
|---|---|
| `caveman` | `appendSystemPrompt`, `transformInput` (the stop phrase), `onSessionStart` (the flag) |
| `ponytail` | `appendSystemPrompt`, `transformInput`, `onSessionStart` |
| `rtk` | `appendSystemPrompt`, `beforeToolCall` (the rewrite and the deny), `afterToolCall` (grep/glob and the shell auto-detect), `onSessionStart` (flag + version probe) |
| `compress` | `onSessionStart`, `onRunEnd` (the footer status) |

Three details worth knowing if you fork this:

1. **`cmd.store` is namespaced per mod.** Each mod owns one file under `~/.commandcode/mods/.store/` and persists exactly one key, `mode`. `/compress` never writes a sibling's state; it calls that mod's exposed `setMode`, so exactly one mod owns each value.
2. **`cmd.getFlag` answers the default at factory time.** Flags are read in `onSessionStart`, after the host binds.
3. **The injected block is byte-stable per level.** The provider's prompt-prefix cache keys off the system prompt, so a level's text must not change between rounds. A level switch swaps the block rather than appending a second one — the text is wrapped in `<caveman>`, `<ponytail>`, or `<rtk>` for exactly that reason.

## Benchmark

Two benches, both runnable. Full protocol: [docs/BENCHMARK.md](./docs/BENCHMARK.md). Measured numbers: [docs/BENCHMARK-RESULTS.md](./docs/BENCHMARK-RESULTS.md).

```bash
npm run bench                     # exact half — rtk byte reduction, rewrite latency, prompt overhead
npm run bench:prompt -- 5 <model> # live half — reply tokens per mode against base
```

The first is deterministic and free: the same fixtures through the same `rtk` binary give the same bytes on any machine. The second spends real tokens and depends on the model, so it reports medians and a run count.

### What the measurements actually found

Two full runs, 900 headless sessions, `nexrouter/deepseek-v4.1-flash`. The most important result is the variance:

| Claim | Result |
|---|---|
| Shell output gets smaller | **Conditionally, exactly.** 73–80% on the grep and glob shapes Command Code produces, 88% on a cargo-style failure, **0%** when hits are one-per-file |
| The host envelope survives | **Yes, asserted.** The `Found N files` header, the pagination notice, and the `Exit code:` line are all kept — the earlier build lost every one |
| A mode adds prompt overhead | **Yes, reproducible.** Within 10% of the static estimate for one mode; presets ~20% above it |
| Caveman shortens replies | **Only `ultra`, ~12–13%**, and only on open prompts. `full` cost tokens in both runs |
| The mode pays off in one turn | **No** — `ultra` saves ~50–70 reply tokens against a 232-token block |
| Any dollar saving | **Not claimed** — no price table, no bill figure |

Three things worth knowing before you trust a benchmark table, this one included:

- **Run-to-run variance beats most of the effects.** Base reply median moved 407 → 525 (+29%) between two runs of the same configuration, and only 4 of 9 mode deltas kept their sign. 5 runs is not enough to rank these modes to ±10%.
- **A length-pinned prompt measures the prompt, not the mode.** On "in three sentences" prompts, `full` and `ultra` swap places versus the open prompts. Both surfaces are published so the reversal is visible.
- **Ponytail is measured on the wrong axis.** Reply tokens say what the ruleset costs (~+536/turn), not whether the code is leaner.

The exact, quotable numbers are the filter bytes and the prompt overhead. The live reply-token rows are directional at best.

## Known limits

- **Caveman does not shorten tool output.** It changes the reply voice. Shell output is rtk's job.
- **Caveman may not shorten replies at all on your model.** Measured here, only `ultra` saved (~12%) and `full` cost tokens in both runs. Treat the mode names as voice settings, not as a savings guarantee.
- **The live benchmark cannot rank modes tightly.** Two runs of the same configuration disagreed on 5 of 9 cases. Quote the filter bytes and the prompt overhead; treat reply-token deltas as directional.
- **The rtk filter is heuristic and declines rather than mangles.** `rtk pipe` refuses anything larger than its input (`never_worse`), so a scattered grep result comes back byte-identical instead of worse — measured at 0.0% on 240 matches across 240 files. A very unusual layout can still read worse; `rtk` mode is off by default and `/rtk off` stops it immediately. The host envelope — header, pagination notice, exit status — is split off before filtering and re-attached verbatim, so those lines are never at risk.
- **The extra shell pass costs a process.** Measured here, 12–15 ms per qualifying result on a warm page cache. Below 1200 bytes the filter never runs, and `/rtk-shell=false` turns the pass off while keeping rewrites.
- **A compressed reply can read as curt.** That is the mode working. `/caveman off` restores normal prose mid-session.
- **No dollar figure is claimed.** Tersio publishes its own benchmark; this package ports the modes. For the shell half, `/rtk gain` reports what rtk itself saved on your machine, read from its own database rather than estimated.

## Develop

```bash
npm test          # node:test — rules, store, prompt surgery, every mod's wiring
npm run verify    # loads each mod through the real Command Code loader
```

Tests drive each mod through its exported factory against a fake `ModApi` (`test/harness.ts`), so the hooks and command handlers are covered, not just the pure helpers.

```
mods/
  shared.ts        per-mod store, prompt blocks, binary lookup
  caveman.ts       /caveman + reply-voice block
  ponytail.ts      /ponytail + lean-code block
  rtk.ts           /rtk + rewrite and filter hooks
  compress.ts      /compress presets + footer status
rules/
  caveman.ts       the six level blocks
  ponytail.ts      the three level blocks
bench/            exact (bytes) + live (reply tokens) benchmarks
docs/             BENCHMARK.md, BENCHMARK-RESULTS.md
test/              100 tests; 9 of them drive the real rtk binary, the rest use a fake
                   ModApi so they run without one
```

## Attribution

Ported from [tersio](https://github.com/KurutoDenzeru/tersio) (MIT, the main reference), [caveman](https://github.com/JuliusBrussee/caveman) (Apache-2.0), [ponytail](https://github.com/DietrichGebert/ponytail) (MIT), and [rtk](https://github.com/rtk-ai/rtk). See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT. See [LICENSE](./LICENSE).

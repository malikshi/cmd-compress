# cmd-compress

Token compression mods for [Command Code](https://commandcode.ai/docs/mods): shorter replies, leaner code, smaller shell output. Four mods, one package.

| Mode | What it changes | Command |
|---|---|---|
| **caveman** | The reply voice. Answer first, filler gone, every technical fact kept. | `/caveman [lite\|full\|ultra\|megacave-*\|off]` |
| **ponytail** | The code you write. Smallest change that fully works; nothing unrequested. | `/ponytail [lite\|full\|ultra\|off]` |
| **rtk** | Shell output. Rewrites `shell_command` through `rtk rewrite`, condenses output no rewrite covered, and filters grep/glob results. | `/rtk [on\|off\|status\|gain]` |
| **compress** | All three at once, at one of four presets. | `/compress [off\|medium\|balanced\|max\|status]` |

Every mode is **off by default**. Nothing changes until you turn it on, and the choice persists across sessions in `~/.commandcode/mods/.store/`.

## Install

```bash
cmd mods add malikshi/cmd-compress        # GitHub
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

`/compress` reports what is *in effect*, not only what was asked for. When the rtk binary is missing or older than 0.25.0, the line says so — `rtk=on (no binary)` or `rtk=on (rtk too old, needs >= 0.25.0)` — because the stored mode alone would overstate the session.

Set one mode on its own when a preset is too blunt:

```
/caveman lite          trim ceremony only
/caveman megacave-full 文言 register
/ponytail ultra        also question the request
/rtk on                rewrite shell commands through rtk
/rtk off
```

Or say `stop caveman` / `stop ponytail` as the whole message. `normal mode` — the phrase both upstream projects use — turns every mode off at once, `rtk` included. An ordinary sentence that merely mentions the mode does not disable it.

Two limits on that phrase, both verified against the host rather than assumed:

- It only fires on input the host routes through `transformInput`, which is **real typed input**. Automated turns, slash commands, and `-p` print runs never reach the hook — measured: a headless `cmd -p "normal mode"` sends the text straight to the model and the mod never runs. Use `/compress off` there.
- `rtk`'s own copy of the phrase is a fallback for a session where caveman and ponytail are not loaded. Whichever mod sees it first turns the siblings off through their exposed `setMode` and answers `handled`, since the host stops the chain at the first `handled`.

### Presets

| Preset | caveman | ponytail | rtk |
|---|---|---|---|
| `off` | off | off | off |
| `medium` | lite | lite | on |
| `balanced` | full | full | on |
| `max` | ultra | ultra | on |

`rtk` is binary — it is either rewriting or it is not — so every live preset turns it on.

The preset names match the upstream combo reference ([tersio](https://github.com/KurutoDenzeru/tersio): `off | medium | balanced | max`). `lite` still works as an alias for `medium`.

### Caveman levels

`lite` trims ceremony only. `full` adds fragments, payload-verbatim, and the bounded-status rule. `ultra` compresses to tables and single clauses. The three `megacave-*` levels use a Classical Chinese register with technical terms kept verbatim.

Every level keeps the same floor: code, commands, paths, numbers, and errors verbatim, every negation intact, and plain prose for a security warning, an irreversible action, or a confused user.

### Ponytail levels

`lite` builds what was asked and names the smaller option. `full` adds the smallest-change ladder and the never-cut list. `ultra` also pushes back on parts of the request the need does not justify.

Every reply ends with one or two lines: what was skipped, and any risk.

## RTK

`rtk` mode shells out to the [RTK](https://github.com/rtk-ai/rtk) binary. Install it first:

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh
```

`/rtk status` reports whether the binary was found and which version it is. When rtk is active:

- **Shell tools are rewritten** through `rtk rewrite` before they run, so `git status` executes as `rtk git status`. This covers both shell tools Command Code exposes: `shell_command` on every platform, and `powershell` where Windows registers it. The full documented exit-code contract is honoured: `0` and `3` carry a rewrite, `1` means no equivalent, and `2` is a deny — a `2` that prints a reason becomes a block carrying that reason, while a silent `2` is a host deny rule rtk only relays and is left to the host to enforce. The emitted `rtk` is **pinned to the absolute path** this mod resolved, because rtk is often installed in a directory the shell does not have on `PATH` (rtk's own installer defaults to `~/.local/bin`) — a bare name there would fail as `rtk: not found`. The pin is a quote-aware scan, so it covers every command position rtk emits (`&&`, `||`, `;`, `|`, `&`, a newline, and a prefix command such as `env`, `nohup`, `time`, `nice`, `command`, `exec`, `builtin`, `stdbuf`, or `timeout`), and it never rewrites text inside a quoted argument — with one exception it must make: rtk rewrites a wrapper's *script*, so `bash -c "git status"` comes back as `bash -c "rtk git status"` with the `rtk` inside quotes. That inner `rtk` is pinned too, or a working command would fail as `rtk: not found` off `PATH`. A single-quoted script that expands (`$`, a backtick) is left byte-identical rather than requoted, since re-quoting it would change what it does.
- **Shell output with no rewrite is still condensed.** `npm test`, `awk`, and `sed` have no rtk equivalent, yet their output can be cargo-test or pytest shaped. Above 1200 bytes it goes through `rtk pipe` with no `-f`, which auto-detects the format and passes the text through unchanged when nothing matches. A call that *was* rewritten is skipped, since rtk already filtered it — with one measured exception. rtk's search filter emits its **faithful baseline** whenever capping would not shrink the output, which is the normal case for a multi-file grep (`grep -rn export mods` measured 4,026 → 4,026 bytes). That baseline carries no recovery hint, so the mod recognises it — no recovery marker (`matches in N files:` or its abbreviated `matches in NF:`, `+N more`, `+ … more files`, `[+N hidden: rtk recall …]`, `[full output: rtk recall …]`) plus a majority of `path:line:text` rows — and runs the second pass: **+33–36%** on those results, and 0 bytes changed on the twelve non-grep commands measured. Anything rtk actually compressed is left byte-identical, because a blind second pass was measured to delete all nine `rtk recall` hashes from grouped output.
- **`grep` and `glob` results are condensed** above 1200 bytes, through `rtk pipe -f grep|find`. The filter is chosen from the result's shape, not its tool name: `grep`'s default `files_with_matches` mode prints a path list under a `Found N files` header, which the grep filter passes through untouched, so that shape is condensed with the find filter instead.
- **A `grep` result with context lines is left alone.** The host's `grep` tool supports `-A/-B/-C`, and ripgrep prints a context line as `path-line-text` where a match is `path:line:text`. rtk's grep filter keeps only the match form, so it silently drops every context line — measured end-to-end, a result with 40 match rows and 40 context rows went 3,178 → 1,665 bytes with all 40 context lines gone. The context is why the caller passed `-A/-B/-C`, so that result is returned unchanged. The check matches the context path against the paths the match rows named, so a file named `src/v2-feat-12-bar1.ts` is not mistaken for one.
- **A compound command split across `command` and `args` is rewritten as one line.** `shell_command` runs `command + ' ' + args`, so `{command: 'cargo', args: ['build']}` is `cargo build`. The rewrite is asked about the joined line and split back only when rtk's answer still ends with the caller's own args — `cargo build` → `rtk cargo` + `build`, args untouched and quoted by the host as before. An answer that no longer lines up (`npx jest` → `rtk jest`) is left alone rather than guessed at.
- **ANSI colour is stripped, on every path.** A test runner or build tool writes colour by default, and rtk's filters return every escape untouched — measured: `rtk pipe` on 10,110 bytes of coloured test output returned all 10,110 bytes with all 720 escapes intact, and the same text without them is 6,750 bytes. The strip needs no binary and no byte floor, so it applies to short results, to grep/glob results, and to a rewritten call that rtk already filtered. Measured savings: **33–34%** on coloured test and `tsc` output.
- **The host's own envelope is never filtered.** Every shape is taken from the host's formatter, not guessed. A `glob` or files-mode `grep` result opens with `Found N files`; a truncated `grep` closes with `[Showing results with pagination = …]`, its count mode with `Found N total occurrences across M files …`, and its timeout with `[Search timed out — …]`; `shell_command` opens with `Exit code: 1` (and the parenthesised interpretation the host adds under it), and closes with `Command aborted`, `Command timed out after …`, a `[cwd change to …]` note, or a `[PowerShell edition: …]` banner. `powershell`, the other shell tool (registered on Windows), renders through the same formatter and is handled on every path. Those lines carry meaning — the count, that the list is truncated, that the command failed — and rtk folds them away as noise. The mod splits them off before the filter and re-attaches them after it, so only the body is ever condensed: the head byte-for-byte, the tail with its notice text exact and only the blank run before it capped at one line.
- **The mid-result truncation pointer is preserved too.** A foreground result over the host's cap is truncated in the *middle* and given a two-line pointer there, not at the end: `[... output truncated: N chars total, showing first X and last part ...]` then `[full output saved to: <path> — read it with read_file (offset/limit) or grep]` (or `[full output could not be persisted]`). Measured: rtk deletes both lines when it compresses — a 2,951-byte pytest result came back at 296 bytes with neither, leaving no route to the rest of the output. The mod lifts the pair out before filtering and puts it back, on the shell and grep/glob paths alike.
- **A filter that loses a fact is refused.** rtk's own guard (`never_worse`) only asks whether the result got *smaller*. Measured against the real binary, a cargo failure of twenty `error[E0xx]: cannot find value …` lines (1,919 bytes) came back as 156 bytes of grep grouping — `20 matches in 1F: [file] --> src/lib.rs (20):` — with every error message gone and no recovery hint. The mod compares the filtered result with the original and refuses one that grouped content which was neither a match list nor a path list, or that dropped a negation. The original then reaches the model unchanged. A real grep or find result still gets condensed, because grouping those is the point.
- **Every failure passes through.** A missing binary, an abort, a non-zero exit from the filter, or a result that came back larger than the original leaves the original untouched. No rtk call can hang a tool call: `cmd.exec` ignores a `timeout` option, so each one runs under an `AbortController`.
- **A failed tool result is never filtered** — the error text reaches the model intact.
- **A binary older than 0.25.0 turns rewrites off** instead of silently doing nothing, since that is the release that added the `rtk rewrite` subcommand (v0.24.0 has none; v0.25.0 does).

`/rtk gain` reads `rtk gain -f json` and reports the token savings rtk itself recorded, so the claim is measured rather than estimated:

```bash
/rtk status   # RTK: on (binary: 1.0.1)
/rtk gain     # RTK saved 2,035,557 tokens over 10,662 commands (40.9%).
```

The figures move as you use rtk; the format and the source (rtk's own ledger) do not.

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
cmd --mod-option rtk-bin=/opt/rtk/bin/rtk
```

A flag beats the stored value for that session. It does not overwrite the store.

`rtk-bin` sets the binary path when the probe misses an unusual install. The probe itself checks `PATH` first, then `$RTK_INSTALL_DIR` (the variable rtk's own installer honours), then `~/.local/bin` (that installer's default), `~/.bun/bin` and `~/.cargo/bin`. An explicit path is checked before it is used: a typo reports `binary: NOT FOUND` and injects no guidance, rather than announcing rewrites that could never run.

## How it works

Each mod is one file, default-exporting a factory that registers a slash command, a flag, and its hooks:

| Mod | Hooks |
|---|---|
| `caveman` | `appendSystemPrompt`, `beforeToolCall` (the `agent` prompt), `transformInput` (the stop phrase), `onSessionStart` (the flag) |
| `ponytail` | `appendSystemPrompt`, `beforeToolCall` (the `agent` prompt), `transformInput`, `onSessionStart` |
| `rtk` | `appendSystemPrompt`, `transformInput` (the `normal mode` fallback), `beforeToolCall` (the rewrite, the deny, and the `agent` prompt), `afterToolCall` (grep/glob and the shell auto-detect), `onSessionStart` (flag + version probe) |
| `compress` | `onSessionStart`, `onRunEnd` (the footer status), plus an `events.on` subscription so the footer also repaints the moment a sibling mode changes |

Three details worth knowing if you fork this:

1. **`cmd.store` is namespaced per mod.** Each mod owns one file under `~/.commandcode/mods/.store/` and persists exactly one key, `mode`. `/compress` never writes a sibling's state; it calls that mod's exposed `setMode`, so exactly one mod owns each value.
2. **`cmd.getFlag` answers the default inside the factory.** The host registers every mod first and applies `--mod-option` values afterwards, so a factory-time read never sees the user's value. Every mode flag is therefore read in `onSessionStart`, and `rtk-bin` is resolved lazily on first use, then cached for the session.
3. **The injected block is byte-stable per level.** The provider's prompt-prefix cache keys off the system prompt, so a level's text must not change between rounds without a durable reason. No strip step is needed: the host rebuilds the append list every round from each mod's `appendSystemPrompt` return, so a level switch swaps the block by returning the new one. Every mode change also emits on the shared `cmd.events` bus, which is how the `/compress` footer repaints immediately instead of waiting for the turn boundary — `cmd.store` is per mod, so a sibling cannot observe the write any other way. `rtk` takes the extra step of awaiting its version probe before it decides whether to inject its guidance block: `onSessionStart` starts that probe fire-and-forget, and deciding first would grant an unsupported binary the benefit of the doubt and then cache the wrong answer for the whole session. The host awaits the hook (verified in the bundled host), and the probe is memoised, so only the first round waits.

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

- **The modes reach sub-agents through the `agent` call's prompt, not through hooks.** A sub-agent run is built with its own system prompt (`definition.systemPrompt`) and a mod list holding only the host's own user-hooks mod (`mods:[a.mod,...e.mods?.({permissionMode})]`, where the provider `Me` answers `[createUserHooksMod(...)]` on Command Code 1.88.2), so `appendSystemPrompt` never fires for it and no rtk hook does either. The one channel the parent still owns is the `agent` tool call itself: the host runs `run({userInput: e.prompt})` for the child and chains `beforeToolCall`'s `input` across mods, so each mode appends its block to that call's `prompt`. The caller's own task text is never rewritten, only extended, and a prompt already carrying the block is left alone so a retried call cannot stack a second copy.
  - **caveman and ponytail** ride in whole, so the child's reply obeys the same level. Verified by behaviour, not self-report: with `megacave-full` loaded the child answered in Classical Chinese, and with `ponytail ultra` it proposed the one-line solution, named the smaller option, and closed with the skipped/risk footer.
  - **rtk** cannot rewrite a child's shell call from the parent — the parent's hooks only ever see its own tool calls — so the child is told to prefix commands itself, with the **absolute path this mod resolved, shell-quoted** (`pinBinary` emits it, single-quoted on POSIX and double-quoted on Windows). The quoting is not cosmetic: the host runs `command` raw and quotes only `args`, so a bare path with a space splits — measured, `/opt/my tools/rtk --version` exited 127 as `sh: /opt/my: not found`, while the quoted form exited 0. Windows puts rtk under `C:\Program Files\`, so that is the default there. The block is added only with a usable, new-enough binary, so it never instructs a session to run something that cannot, and it is **not** sent to `explore` or `plan` — their bundled tool sets have no shell at all (measured: 7-byte prompt, the task text alone), so the block would be dead weight on every delegation. Verified: a child received the quoted path and ran real `rtk` through it.
  - A mode that is off adds nothing. Both the caveman/ponytail blocks and the rtk block are byte-stable per level, so a child's prompt cache behaves like the parent's.
  - **A child's own reasoning about this is not evidence.** Asked directly whether a block was in its instructions, a child answered "NONE" while a probe on the same run showed the 1003-byte block in its prompt — the report is generated by the parent, which cannot see the child's context. Trust a behavioural check or a probe that logs the `agent` call's `input.prompt`, not the child's account of its own instructions.
  - **Prefixing does not compress a compound command.** rtk passes a shell wrapper through: `rtk sh -c '…'` came back byte-identical to the unfiltered run (84,069 bytes both ways), because the filter sees the wrapper, not the command. The block's value is therefore commands rtk actually knows — measured 84,069 → 31,046 bytes (63%) when the same `grep -rn` output went through `rtk pipe -f grep`.
- **Caveman does not shorten tool output.** It changes the reply voice. Shell output is rtk's job.
- **Caveman may not shorten replies at all on your model.** Measured here, only `ultra` saved (~12%) and `full` cost tokens in both runs. Treat the mode names as voice settings, not as a savings guarantee.
- **The live benchmark cannot rank modes tightly.** Two runs of the same configuration disagreed on 5 of 9 cases. Quote the filter bytes and the prompt overhead; treat reply-token deltas as directional.
- **The rtk filter is heuristic and declines rather than mangles.** `rtk pipe` refuses anything larger than its input (`never_worse`), so a scattered grep result comes back byte-identical instead of worse — measured at 0.0% on 240 matches across 240 files. A very unusual layout can still read worse; `rtk` mode is off by default and `/rtk off` stops it immediately. The host envelope — header, pagination notice, exit status, cwd note, PowerShell banner — is split off before filtering and re-attached verbatim, so those lines are never at risk.
- **A grouped list can elide repeated names.** rtk's find and grep filters print `+N` for repeated paths or matches; when the full output was not stored, those names cannot be recovered from a `rtk recall` hash, and the count is all that remains. The injected guidance says so. When you need every name, re-run unfiltered or narrow the pattern, or set `--mod-option rtk-filter=false` for the session.
- **The extra shell pass costs a process.** Measured here, 11–17 ms per qualifying result on a warm page cache. Below 1200 bytes the filter never runs, and `--mod-option rtk-shell=false` turns the pass off while keeping rewrites. The colour strip is separate and free: it needs no process, so it runs on every result at any size.
- **A rewrite costs rtk's own startup.** `rtk rewrite` is a process spawn; measured here at a median of 72 ms per command that has an equivalent, and 13–37 ms for one that defers. That is rtk's cost, not this mod's — tersio pays it too. `/rtk off` removes it entirely.
- **A compressed reply can read as curt.** That is the mode working. `/caveman off` restores normal prose mid-session.
- **Windows is supported but less exercised than POSIX.** The filter redirect runs through `cmd.exe /d /s /c`, and a pinned path is double-quoted because cmd.exe gives single quotes no meaning. Both are unit-tested on every OS, and a real `cmd.exe` redirect is asserted by the `windows-latest` CI job; the maintainer's own runs are on Linux, so a Windows-specific report matters more here than elsewhere.
- **A stop phrase needs real typed input.** `normal mode` and `stop caveman` ride `transformInput`, which the host only routes for typed prompts — a headless `-p` run never reaches it, so the phrase goes to the model instead. `/compress off` works everywhere.
- **The `/compress` footer repaints on a bus event, not by polling.** Each mod emits on `cmd.events` when its mode changes, because `cmd.store` is per mod and a sibling cannot read the write. A host that does not provide `events` degrades to the turn-boundary repaint from `onRunEnd`; the mode change itself always works.
- **No dollar figure is claimed.** Tersio publishes its own benchmark; this package ports the modes. For the shell half, `/rtk gain` reports what rtk itself saved on your machine, read from its own database rather than estimated.

## Develop

```bash
npm test           # node:test — rules, store, prompt surgery, every mod's wiring
npm run typecheck  # tsc --noEmit against types/harness.d.ts
npm run verify     # typecheck, tests, then import every mod and run its factory
```

`npm run verify` is the gate CI runs on Linux, macOS, and Windows against Node 22.18+ and 24. `cmd mods inspect` only reads the source text, so it cannot catch a factory that throws; `scripts/verify-mods.ts` imports each mod and runs its factory against a stub API, which does.

Tests drive each mod through its exported factory against a fake `ModApi` (`test/harness.ts`), so the hooks and command handlers are covered, not just the pure helpers.

Command Code ships no type declarations, so `types/harness.d.ts` is a hand-written slice of the documented mod API. It exists because a hook that returns a field the host never reads is a silent no-op at runtime, but a type error there.

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
types/
  harness.d.ts     the mod API slice the package compiles against
bench/            exact (bytes) + live (reply tokens) benchmarks
docs/             BENCHMARK.md, BENCHMARK-RESULTS.md
test/              the suite drives each mod through its exported factory; the rtk-shape
                   tests use the real binary when installed and skip when it is absent
```

## Attribution

Ported from [tersio](https://github.com/KurutoDenzeru/tersio) (MIT, the main reference), [caveman](https://github.com/JuliusBrussee/caveman) (Apache-2.0), [ponytail](https://github.com/DietrichGebert/ponytail) (MIT), and [rtk](https://github.com/rtk-ai/rtk). See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT. See [LICENSE](./LICENSE).

# cmd-compress

Token compression mods for [Command Code](https://commandcode.ai/docs/mods): shorter replies, leaner code, smaller shell output. Four mods, one package.

| Mode | What it changes | Command |
|---|---|---|
| **caveman** | The reply voice. Answer first, filler gone, every technical fact kept. | `/caveman [lite\|full\|ultra\|megacave-*\|off]` |
| **ponytail** | The code you write. Smallest change that fully works; nothing unrequested. | `/ponytail [lite\|full\|ultra\|off]` |
| **rtk** | Shell output. Rewrites `shell_command` through `rtk rewrite` and condenses grep/glob results. | `/rtk [on\|off\|status]` |
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

Or say `stop caveman` / `stop ponytail` as the whole message. An ordinary sentence that merely mentions the mode does not disable it.

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

`/rtk status` reports whether the binary was found. When rtk is active:

- **`shell_command` is rewritten** through `rtk rewrite` before it runs, so `git status` executes as `rtk git status`. The exit-code contract is honoured: `0` and `3` are rewrites, `1` means no equivalent, `2` means blocked — only `0` and `3` are applied.
- **`grep` and `glob` results are condensed** above 1200 bytes, through `rtk pipe -f grep|find`.
- **Every failure passes through.** A missing binary, a timeout, a non-zero exit from the filter, or a result that came back larger than the original leaves the original untouched.
- **A failed tool result is never filtered** — the error text reaches the model intact.

Turn the grep/glob filter off but keep the rewrite:

```bash
cmd --mod-option rtk-filter=false
```

## Flags

Each mod takes a per-session starting mode, applied when the session binds:

```bash
cmd --mod-option caveman=full --mod-option ponytail=ultra --mod-option rtk=on
cmd --mod-option rtk-filter=false
```

A flag beats the stored value for that session. It does not overwrite the store.

## How it works

Each mod is one file, default-exporting a factory that registers a slash command, a flag, and its hooks:

| Mod | Hooks |
|---|---|
| `caveman` | `appendSystemPrompt`, `transformInput` (the stop phrase), `onSessionStart` (the flag) |
| `ponytail` | `appendSystemPrompt`, `transformInput`, `onSessionStart` |
| `rtk` | `appendSystemPrompt`, `beforeToolCall` (the rewrite), `afterToolCall` (the filter), `onSessionStart` |
| `compress` | `onSessionStart`, `onRunEnd` (the footer status) |

Three details worth knowing if you fork this:

1. **`cmd.store` is namespaced per mod.** Each mod owns one file under `~/.commandcode/mods/.store/` and persists exactly one key, `mode`. `/compress` never writes a sibling's state; it calls that mod's exposed `setMode`, so exactly one mod owns each value.
2. **`cmd.getFlag` answers the default at factory time.** Flags are read in `onSessionStart`, after the host binds.
3. **The injected block is byte-stable per level.** The provider's prompt-prefix cache keys off the system prompt, so a level's text must not change between rounds. A level switch swaps the block rather than appending a second one — the text is wrapped in `<caveman>`, `<ponytail>`, or `<rtk>` for exactly that reason.

## Known limits

- **Caveman does not shorten tool output.** It changes the reply voice. Shell output is rtk's job.
- **The rtk filter is heuristic.** `rtk pipe -f grep` groups and truncates; a very unusual grep layout can come back less legible than the original. `rtk` mode is off by default and `/rtk off` stops it immediately.
- **A compressed reply can read as curt.** That is the mode working. `/caveman off` restores normal prose mid-session.
- **No measured savings are claimed here.** Tersio publishes its own benchmark; this package ports the modes, not the measurements. Measure your own with `rtk gain` for the shell half.

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
test/              46 tests
```

## Attribution

Ported from [tersio](https://github.com/KurutoDenzeru/tersio) (MIT, the main reference), [caveman](https://github.com/JuliusBrussee/caveman) (Apache-2.0), [ponytail](https://github.com/DietrichGebert/ponytail) (MIT), and [rtk](https://github.com/rtk-ai/rtk). See [ATTRIBUTION.md](./ATTRIBUTION.md).

## License

MIT. See [LICENSE](./LICENSE).

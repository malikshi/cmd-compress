# Attribution

`cmd-compress` is a port of four upstream projects to the Command Code mod API.
Their rule text and the mechanics this package adapts are listed here, with the
original license for each.

## KurutoDenzeru/tersio — MIT

<https://github.com/KurutoDenzeru/tersio>

The main reference. This package adapts Tersio's mode architecture:

- the per-mode session toggle with persisted state (`extensions/caveman`, `extensions/rtk`),
- the `/combo` preset concept, reworked as `/compress` (`extensions/combo`),
- the `rtk rewrite` / `rtk pipe` integration (`extensions/rtk/filter.ts`),
- the status-line idea, reduced to one footer segment (`extensions/shared/status.ts`).

Files adapted: `mods/caveman.ts`, `mods/ponytail.ts`, `mods/rtk.ts`, `mods/compress.ts`, `mods/shared.ts`.

```
MIT License

Copyright (c) 2026 KurutoDenzeru
```

## JuliusBrussee/caveman — Apache-2.0

<https://github.com/JuliusBrussee/caveman>

The caveman voice. The rule blocks in `rules/caveman.ts` are derived from the
`caveman`, `ultracave`, and `megacave` skills under
`plugins/caveman/skills/`, trimmed to the rules that change output and rewritten
for a mod (no skill frontmatter, no host-specific status relay).

```
Copyright the caveman contributors
Licensed under the Apache License, Version 2.0
http://www.apache.org/licenses/LICENSE-2.0
```

## DietrichGebert/ponytail — MIT

<https://github.com/DietrichGebert/ponytail>

The lean-code ruleset. `rules/ponytail.ts` is derived from
`skills/ponytail/SKILL.md` and the mode-filtering logic in
`hooks/ponytail-instructions.ts` (one shared ruleset, level-specific preamble).

```
MIT License

Copyright (c) 2026 DietrichGebert
```

## rtk-ai/rtk — Apache-2.0 + BUSL-1.1

<https://github.com/rtk-ai/rtk>

`mods/rtk.ts` adapts the hook design from `hooks/pi/rtk.ts`: rewrite through the
`rtk rewrite` exit-code contract (0/1/2/3), fail open on every path, and the
agent-facing awareness text from `hooks/rtk-awareness*.md`.

Three things here are this package's own, not upstream:

- **The host-envelope split** (`splitSegments`). Upstream hooks only rewrite a
  command; they never post-process a tool result this host wrapped. Command
  Code opens a `glob` with `Found N files`, closes a truncated result with a
  pagination or truncation notice, and opens a `shell_command` result with
  `Exit code: N`. rtk treats those as noise. This package cuts them off before
  filtering and re-attaches them verbatim.
- **`pinBinary`.** `rtk rewrite` answers a bare `rtk …`, but this mod can find
  rtk in `~/.bun/bin` when the host shell's `PATH` does not include it. Pinning
  each command-position `rtk` to the resolved absolute path is what stops a
  rewrite from turning a working command into `rtk: not found`.
- **The auto-detect output pass** for shell calls that got no rewrite, and the
  `grep`/`glob` result filter, both driven from `rtk pipe`.

**This package does not vendor or reimplement RTK.** It shells out to an `rtk`
binary the user installs separately. The Rust source is not copied. See the
upstream repository for RTK's own license terms, which include a BUSL-1.1
component covering the RTK binary.

## Command Code

<https://commandcode.ai/docs/mods>

The mod API, its hook contracts, and the packaging format are documented by
Command Code. The `mods/` here are written against that API.

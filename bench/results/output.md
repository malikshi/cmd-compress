# Command output benchmark

Measured: 2026-11-03T07:24:12.004Z
rtk binary: /root/.bun/bin/rtk

Byte ratios reproduce across machines. Milliseconds do not — compare percentages.

| Case | Shape | Bytes in | Bytes out | Saved | Mean | Fidelity |
|---|---|---:|---:|---:|---:|---|
| grep, clustered | 240 matches in 6 files (40 per file) | 16,130 | 3,148 | 80.5% | 14 ms | 6/6 files named, 60 of 240 match lines kept |
| grep, scattered | 240 matches in 240 files (1 per file) | 14,874 | 14,874 | 0.0% | 14 ms | passed through unchanged (240 matches, 240 files) |
| find | 260 paths in 10 dirs | 6,092 | 1,748 | 71.3% | 13 ms | 10/10 dirs named, header claims 260 files in 10 dirs |
| glob tool | 260 paths + Found header | 4,326 | 1,149 | 73.4% | 14 ms | header kept |
| glob tool, truncated | 260 paths + truncation notice | 5,021 | 1,345 | 73.2% | 13 ms | header kept, trailer kept |
| grep tool, truncated | 240 matches + pagination notice | 15,540 | 3,183 | 79.5% | 13 ms | trailer kept |
| shell tool | cargo failure + Exit code head | 2,769 | 324 | 88.3% | 13 ms | header kept |

| Case | Commands | Rewritten | Mean | p95 |
|---|---:|---:|---:|---:|
| rewrite lookup | 12 | 12 | 82.6 ms | 146.1 ms |

## Prompt overhead per mode

The block is injected once per session and re-sent every turn. Estimated tokens use chars/4 — an estimate, not a tokenizer count.

| Mode | Level | Bytes | Est. tokens | Est. tokens over 5 turns |
|---|---|---:|---:|---:|
| caveman | lite | 548 | ~137 | ~685 |
| caveman | full | 1,858 | ~465 | ~2325 |
| caveman | ultra | 953 | ~239 | ~1195 |
| caveman | megacave-lite | 795 | ~189 | ~945 |
| caveman | megacave-full | 1,114 | ~257 | ~1285 |
| caveman | megacave-ultra | 668 | ~163 | ~815 |
| ponytail | lite | 2,356 | ~588 | ~2940 |
| ponytail | full | 2,402 | ~600 | ~3000 |
| ponytail | ultra | 2,475 | ~618 | ~3090 |


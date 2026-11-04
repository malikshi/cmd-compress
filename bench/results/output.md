# Command output benchmark

Measured: 2026-11-04T15:39:44.489Z
rtk binary: /root/.bun/bin/rtk

Byte ratios reproduce across machines. Milliseconds do not — compare percentages.

| Case | Shape | Bytes in | Bytes out | Saved | Mean | Fidelity |
|---|---|---:|---:|---:|---:|---|
| grep, clustered | 240 matches in 6 files (40 per file) | 16,130 | 1,377 | 91.5% | 1 ms | 6/6 files named, 240 of 240 match lines kept |
| grep, scattered | 240 matches in 240 files (1 per file) | 14,874 | 13,421 | 9.8% | 2 ms | 240/240 files named, 240 of 240 match lines kept |
| find | 260 paths in 10 dirs | 6,092 | 1,149 | 81.1% | 0 ms | 10/10 dirs named, header claims 260 files in 10 dirs |
| glob tool | 260 paths + Found header | 4,326 | 788 | 81.8% | 0 ms | local path condenser, header kept |
| glob tool, truncated | 260 paths + truncation notice | 5,021 | 964 | 80.8% | 0 ms | local path condenser, header kept, trailer kept |
| grep tool, truncated | 240 matches + pagination notice | 15,540 | 1,333 | 91.4% | 0 ms | local row condenser, trailer kept |
| grep tool, files mode | 300 paths + Found header (find filter takes over) | 4,448 | 439 | 90.1% | 0 ms | local path condenser, header kept |
| grep tool, count mode | 400 hits + total-occurrences notice | 17,228 | 2,509 | 85.4% | 1 ms | local row condenser, trailer kept |
| shell tool | cargo failure + Exit code head | 2,769 | 324 | 88.3% | 13 ms | header kept |
| shell tool, timed out | pytest failure + timeout notice | 5,889 | 339 | 94.2% | 12 ms | header kept, trailer kept |
| shell tool, declined grep baseline | multi-file match rows rtk refused to group | 8,081 | 430 | 94.7% | 1 ms | local row condenser |
| shell tool, coloured build | 40 tsc errors with SGR colour | 5,274 | 3,474 | 34.1% | 14 ms | header kept |

| Case | Commands | Rewritten | Mean | p95 |
|---|---:|---:|---:|---:|
| rewrite lookup | 12 | 12 | 153.8 ms | 582.5 ms |

## Prompt overhead per mode

The block is injected once per session and re-sent every turn. Estimated tokens use chars/4 — an estimate, not a tokenizer count.

| Mode | Level | Bytes | Est. tokens | Est. tokens over 5 turns |
|---|---|---:|---:|---:|
| caveman | lite | 928 | ~231 | ~1155 |
| caveman | full | 1,858 | ~465 | ~2325 |
| caveman | ultra | 973 | ~244 | ~1220 |
| caveman | megacave-lite | 1,134 | ~269 | ~1345 |
| caveman | megacave-full | 1,298 | ~300 | ~1500 |
| caveman | megacave-ultra | 852 | ~207 | ~1035 |
| ponytail | lite | 2,356 | ~588 | ~2940 |
| ponytail | full | 2,402 | ~600 | ~3000 |
| ponytail | ultra | 2,475 | ~618 | ~3090 |


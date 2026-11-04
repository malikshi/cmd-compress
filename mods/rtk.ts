// rtk — condensed command output: rewrites shell_command through `rtk rewrite`, condenses the output a rewrite cannot cover, and filters grep/glob results.
// exports: default, REWRITE_TIMEOUT_MS, MIN_FILTER_BYTES, MIN_SUPPORTED_RTK_MINOR, shouldRewrite, pinBinary, splitSegments, findTrailer, filterNameFor, filterForShape, isGrepRows, hasGrepContext, canRefilterCompressed, stripAnsi, extractSpillNotices, checkFidelity, parseRtkVersion, isSupportedVersion, classifyRewrite, joinForRewrite, splitRewrite, guidanceText
// used_by: package.json (commandcode.mods), mods/compress.ts, bench/output.ts, test/rtk-shapes.test.ts, test/mods.test.ts
// related: mods/shared.ts
// rules: fail open on every path — a missing binary, an abort, an unexpected exit code, or a malformed payload leaves the original untouched.
// rules: exit 2 is a deny from rtk's own contract: a message on stdout names the rule that blocked it, so it becomes a block; empty means a Claude-only deny rule the host does not own, so it passes.
// rules: the host's own envelope — a `Found N files` header, a pagination notice, an `Exit code:` line — is split off before filtering and re-attached after. The head is re-attached byte-for-byte; the tail keeps its notice text exactly, with the blank run before it capped at one line. rtk folds those as noise; they carry the count, the truncation, and the failure.
// rules: a shell result can end with two consecutive notices (the cwd note, then the PowerShell edition banner); every consecutive notice is split off, never just the last, or rtk deletes the earlier one with the body.
// rules: never return a reassembled result larger than the original. rtk's never-worse guard covers only the body it saw; the envelope and re-attached notices can add bytes.
// rules: the emitted `rtk` is pinned to the resolved absolute path. rtk ships to ~/.local/bin (its installer default), ~/.bun/bin or ~/.cargo/bin, and a GUI host often has none of them on PATH, so a bare name would turn a working command into `rtk: not found`. The pin is a quote-aware single pass, because rtk emits `&`, newlines, and prefix commands, and a quoted argument may contain both `rtk` and a separator. The one quoted form it does reach into is a shell wrapper's script (`bash -c "rtk …"`), which rtk rewrites and which is a command line in its own right.
// rules: `shell_command` and `powershell` are both shell tools with the same result envelope, so every path keys off `isShellTool`, not the one name — a Windows session would otherwise get no rewrite and no condensing at all.
// rules: a rewritten shell call is skipped unless rtk left its faithful baseline — no recovery marker and a majority of `path:line:text` rows — because rtk's own never-worse guard declines to compress multi-file grep output by default.
// rules: `shell_command`'s `args` array is part of the command line the host runs, so the rewrite sees it; a `-A/-B/-C` grep result is never handed to rtk's grep filter, which keeps only match rows and would silently drop the context the caller asked for.
// rules: ANSI escapes are stripped from the body before rtk runs, and from a result the rtk pass declined. Measured: rtk returns all 10,110 bytes of a coloured test result with all 720 escapes intact, and the escape-free text is 6,750 bytes — 33.2% smaller. A tsc-shaped failure is 34.2% smaller. Colour carries no fact, so this is the one compression that needs no binary.
// agent: unknown | unknown | 2026-11-03 | unknown | pinBinary rewritten as a quote-aware scan after measuring two live bugs: `&` and newline separators it emits were left bare (a rewrite then failed as `rtk: not found` off PATH), and a `rtk` inside a quoted argument was rewritten, corrupting the argument
// agent: unknown | unknown | 2026-11-03 | unknown | inspect rtk 1.1.0 against the mod: cover the `powershell` shell tool, accept rtk's abbreviated `NF:` grouping header in both the recovery and fidelity markers, and probe every documented install dir (rtk's own installer writes ~/.local/bin, not ~/.bun/bin)
// agent: unknown | unknown | 2026-11-03 | unknown | two measured defects: `shell_command`'s `args` were never part of the rewrite lookup (every compound call missed), and a `-A/-B/-C` grep result had its context rows silently dropped by rtk's grep filter; forcing a filter on misdetected text measured destructive, so auto-detect stays
// agent: unknown | xai | 2026-11-04 | 01a1a3cc | review fixes: split every consecutive host notice, recognise Windows drive-letter grep rows, refuse an inflated reassembly, and gate spawns on an executable binary without suppressing the colour strip
// agent: unknown | unknown | 2026-11-04 | unknown | measured review: splitRewrite dropped every prefixed/chained/expanded rewrite (7 of 10 commands), the negation count refused rtk's row-eliding grouping (41,739 -> 11,252 bytes declined), and valueless prefix flags (`env -i`, `exec -c`) ate the payload; raw args join kept and documented because quoting makes rtk defer

import type {ModApi} from '@commandcode/harness';
import {accessSync, constants, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {announceMode, filterShell, isShellTool, NORMAL_MODE, pipeCommand, readOwnMode, resolveBin, turnOffSiblings, windowsPipeScript, wrapBlock, writeOwnMode, OFF} from './shared.ts';

export const REWRITE_TIMEOUT_MS = 2000;

// Rules: below this the extra process costs more than the filter saves.
export const MIN_FILTER_BYTES = 1200;

// Rules: `rtk rewrite` first appears in 0.25.0 — verified against the upstream tree, where v0.24.0 has no Rewrite subcommand and v0.25.0 does. An older binary fails every rewrite open, so say so instead of pretending to work.
export const MIN_SUPPORTED_RTK_MINOR = 25;

const FILTER_TIMEOUT_MS = 5000;

const FILTER_BY_TOOL: Record<string, string> = {grep: 'grep', glob: 'find'};

// Rules: owned-key lookup only. `FILTER_BY_TOOL[name]` walks the prototype chain, so a tool named `toString` or `constructor` answers a function, which would reach `rtk pipe -f` as the filter name and spawn a pointless process for a name rtk does not know.
export function filterNameFor(toolName: string): string | undefined {
	return Object.hasOwn(FILTER_BY_TOOL, toolName) ? FILTER_BY_TOOL[toolName] : undefined;
}

/* ------------------------------------------------------------ tool envelopes */

export interface Segments {
	readonly head: string;
	readonly body: string;
	readonly tail: string;
}

// Rules: the last lines of a Command Code result often carry the truth the body hides. Each form is taken from the host's own formatter, not guessed: grep's content mode closes with `[Showing results with pagination = …]`, its count mode with `Found N total occurrences across M files[ with pagination = …].`, and the grep tool times out with `[Search timed out — …]`; glob closes with `(Results are truncated: …)` or `(Search timed out …)`; a `shell_command` that ends early appends `Command aborted` or `Command timed out after Nms (exit code 124). …`, and `formatResult2` puts the cwd note and the PowerShell edition banner after the output. rtk folds all of them away as noise, so they are cut off before the filter and re-attached after it.
// Rules: anchored to the end of the whole result, not to any line end — a notice that merely appears mid-output is body text and must be filtered with it.
// Rules: every notice is a SINGLE line at the end of the result. A leading `\n*` plus a trailing `[\s]*$` made the engine retry every offset and re-scan the tail each time, which is quadratic in a long blank run: measured 825 ms at 20k newlines and 9.8 s at 60k, on a result the session is blocked on. Stripping the blank padding first makes it one pass.
const NOTICE_SOURCE =
	'\\[(?:Showing results with pagination|Search timed out)[^\\]\\n]*\\]' +
	'|\\(Results are truncated: [^)\\n]*\\)' +
	'|\\(Search timed out[^)\\n]*\\)' +
	'|\\[cwd change to [^\\]\\n]*\\]' +
	'|\\[PowerShell edition: [^\\]\\n]*\\]' +
	'|Found \\d+ total occurrences? across \\d+ files?(?: with pagination = [^\\n]*)?\\.' +
	'|Command (?:aborted|timed out after [^\\n]*)';

// Rules: the host appends more than one notice to some results (`formatResult2` writes the cwd note, then the PowerShell edition banner), so a single match would leave the earlier notice in the body for rtk to fold away. The shared source feeds the whole-line test.
const NOTICE_LINE = new RegExp(`^(?:${NOTICE_SOURCE})$`);

// Rules: `formatResult2` puts the exit status and the signal on the first lines, before any output, and follows the exit status with a parenthesised interpretation (`(No matches found)`, `(test failure)`). Both are host words, not output, and rtk drops them, so they are split with the head. The interpretation is only recognised directly after an `Exit code:` line, so a body that happens to start with a parenthesis is not eaten.
const SHELL_HEAD = /^(?:(?:(?:Exit code|Signal):[^\n]*\n)(?:\([^)\n]*\)\n)?)+/;

// Rules: the notice is the last non-blank line, so the scan starts there. `index` is the start of the blank run in front of it — the same boundary the old `\n*` prefix produced, so the body never carries the padding. `blank` is the separator to re-attach (capped at two newlines, matching what the tests pin).
export function findTrailer(text: string): {index: number; match: string; blank: string} | null {
	let end = text.length;
	while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1;
	if (end === 0) return null;
	// Rules: trailing whitespace after the notice must be trimmed before matching, or the notice is missed and rtk folds it away with the body. The old pattern consumed it with `[\s]*$`; doing it here keeps the match to one pass.
	const trimmed = text.slice(0, end);
	let first = trimmed.lastIndexOf('\n') + 1;
	if (!NOTICE_LINE.test(trimmed.slice(first))) return null;
	// Rules: consume every consecutive notice line, not just the last. A shell result can carry a cwd note followed by the PowerShell banner; splitting only the banner feeds the note to rtk, which deletes it.
	while (first > 0) {
		const prevEnd = first - 1;
		const prevStart = trimmed.lastIndexOf('\n', prevEnd - 1) + 1;
		if (!NOTICE_LINE.test(trimmed.slice(prevStart, prevEnd))) break;
		first = prevStart;
	}
	let runStart = first;
	while (runStart > 0 && trimmed[runStart - 1] === '\n') runStart -= 1;
	const blank = first - runStart >= 2 ? '\n\n' : '\n';
	return {index: runStart, match: trimmed.slice(first), blank};
}

// Rules: `glob` prints `Found N files` and then one indented path per line. The find filter reads that header line as a path, so it is split off rather than fed in.
const GLOB_HEAD = /^Found \d+ files?[^\n]*\n/;

// Rules: every form rtk emits when it actually compressed something, taken from its own source (`core/tee.rs`, `core/runner.rs`, `cmds/system/search.rs`, `cmds/system/pipe_cmd.rs`, `cmds/js/lint_cmd.rs`): the grouped-search header (two spellings — `N matches in M files:` from `search.rs`, `N matches in MF:` from `pipe_cmd.rs`), a per-file or per-run elision count, and the three recall hints. A result carrying one of these has already been reduced and may hold a recall hash the filter would drop, so it is never fed back in.
const RECOVERY_MARKER = /\bmatches in \d+(?: files?|F):|\+\d+ more|\+ \.\.\. more files|hidden: rtk recall |\[full output:/;

// Rules: rtk's search filter prints its faithful baseline whenever capping would not shrink the output, which is the normal case for a multi-file grep (measured 4,026 -> 4,026 bytes). That baseline is exempt from the filter by construction, so a shell call rtk rewrote can still arrive uncompressed.
// Rules: the rows are recognised by shape — `path:line:text` — and a majority is required, so a diff, a log, or a build log that happens to contain one such line is not mistaken for a match list.
// Rules: a Windows match row is `C:\src\a.ts:12:text`; the drive colon is consumed explicitly so the rest of the path may not hide one. A bare `.*` would also read `http://host:8080:x` as a row. Own match on the same pattern so the path can be read back for the context test.
const GREP_ROW = /^((?:[A-Za-z]:[\\/])?[^\s:][^:\n]*):\d+:[^\n]*$/;
export function isGrepRows(text: string): boolean {
	const lines = text.split('\n').filter(line => line.trim());
	if (lines.length < 2) return false;
	let rows = 0;
	for (const line of lines) if (GREP_ROW.test(line)) rows += 1;
	return rows / lines.length >= 0.5;
}

// Rules: ripgrep separates a match from its context with different delimiters — `path:line:text` for a match, `path-line-text` for a `-A/-B/-C` context line (verified with `rg -A1`: `2:beta` then `3-gamma`). rtk's grep filter only understands the match form, so every context line is dropped (measured: 40 match rows plus 40 context rows, 3,178 -> 1,665 bytes with all 40 context lines gone). The context is the reason the caller passed `-A/-B/-C`.
// Rules: the file prefix must match one the match rows already named, because a path alone is not evidence — `src/v2-feat-12-bar1.ts` has the shape `<path>-<digits>-` and a bare delimiter test reads it as a context row (measured: a 40-path find-mode list was refused as lost context). Requiring a known path removes that false positive while keeping the single-file form, where the prefix is empty on both rows.
const GREP_CONTEXT_ROW = /^([\s\S]*?)-\d+-/;

export function hasGrepContext(text: string): boolean {
	const lines = text.split('\n').filter(line => line.trim());
	const knownPaths = new Set<string>();
	for (const line of lines) {
		const path = GREP_ROW.exec(line)?.[1];
		if (path !== undefined) knownPaths.add(path);
	}
	if (knownPaths.size === 0) return false;
	for (const line of lines) {
		if (GREP_ROW.test(line)) continue;
		const path = GREP_CONTEXT_ROW.exec(line)?.[1];
		if (path !== undefined && knownPaths.has(path)) return true;
	}
	return false;
}

// Rules: a rewritten call is normally left alone because rtk already filtered it. The exception is the baseline rtk declined to compress: it carries no recovery hint, so a second pass recovers rows it refused to group instead of discarding information.
export function canRefilterCompressed(text: string): boolean {
	return !RECOVERY_MARKER.test(text) && isGrepRows(text);
}

// Rules: `grep` is not one shape. Its default `files_with_matches` mode prints a plain path list under a `Found N files` header, which the grep filter passes through untouched (measured 4,448 → 4,448 bytes) while the find filter condenses it (→ 630). Content mode is the opposite: `path:line:text` rows, where grep wins. So the filter is chosen from the body's shape, not from the tool name alone.
export function filterForShape(toolName: string, filter: string | null, text: string): string | null {
	if (toolName === 'grep' && GLOB_HEAD.test(text)) return 'find';
	return filter;
}

// Rules: a result is split into the envelope the host wrote and the body rtk should condense; only the body is ever filtered, so no host information is lost.
// Rules: the tail keeps the host's own separator, capped at one blank line — enough to keep the notice visually separate without carrying a run of blank lines the filter just folded.
function tailFrom(trailer: {match: string; blank: string}): string {
	return `${trailer.blank}${trailer.match.trimStart()}`;
}

export function splitSegments(toolName: string, text: string): Segments {
	// Rules: `grep`'s default files mode opens with the same `Found N files` line `glob` does, so both split it off; a content-mode body starts with `path:line:text` and never matches.
	if (toolName === 'glob' || toolName === 'grep') {
		const head = GLOB_HEAD.exec(text);
		if (head) {
			const rest = text.slice(head[0].length);
			const trailer = findTrailer(rest);
			if (!trailer) return {head: head[0], body: rest, tail: ''};
			return {head: head[0], body: rest.slice(0, trailer.index), tail: tailFrom(trailer)};
		}
	}
	const trailer = findTrailer(text);
	if (trailer) {
		const body = text.slice(0, trailer.index);
		const head = SHELL_HEAD.exec(body);
		const tail = tailFrom(trailer);
		return head ? {head: head[0], body: body.slice(head[0].length), tail} : {head: '', body, tail};
	}
	if (isShellTool(toolName)) {
		const head = SHELL_HEAD.exec(text);
		if (head) return {head: head[0], body: text.slice(head[0].length), tail: ''};
	}
	return {head: '', body: text, tail: ''};
}

/* --------------------------------------------------------------- ansi */

// Rules: a test runner or a build tool emits colour by default, and rtk's filters pass the escapes straight through — measured on 10,110 bytes of realistic coloured test output, rtk returned all 10,110 bytes with all 720 escapes intact, while the same text without them was 6,750 bytes (33.2% smaller). Colour carries nothing the model reads, so it is removed before anything else.
// Rules: only text-carrying sequences are matched — CSI (colour, cursor), OSC (titles, hyperlinks, clipboard writes) and the two-byte escapes. Anything else is left alone rather than eaten by a pattern wide enough to swallow real output.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

// Rules: the fast path matters — every large result goes through here, and most have no escape at all.
export function stripAnsi(text: string): string {
	return text.includes('\u001B') ? text.replace(ANSI, '') : text;
}

/* --------------------------------------------------------------- fidelity */

// Rules: rtk's own byte guard (`never_worse`) only asks whether the output got smaller, never whether it still says the same thing, and its auto-detect can pick the wrong filter. Measured against the real binary: a cargo-style block of 20 `error[E0xx]: cannot find value …` lines plus context came back from `rtk pipe` as 156 bytes reading `20 matches in 1F:` then `[file] --> src/lib.rs (20):` — every one of the 20 error messages was gone, with no recovery hint. The same text is what an agent needs to fix a build.
// Rules: the guard targets that failure, not an ideal of lossless compression. A readable filter summarises on purpose — `FAILURES (1): 1. tests::fails_here` is a good result — so the check is format-shaped instead of atom-by-atom: when rtk auto-detected and produced its grep/find grouping while the original was neither `path:line:text` rows nor a path list, the guess was wrong and the original is kept. Negation loss is refused too, since that inverts meaning and no legitimate summariser drops one.
const NEGATION = /\b(?:not|no|never|without|cannot|can't|don't|doesn't|didn't|isn't|aren't|won't|wouldn't|shouldn't|couldn't|neither|nor)\b/gi;
// Rules: the guard catches rtk's grouped form — a `N matches in M files:` header or a `[file] path:` block header — because that is what its grep/find filters emit when they summarise.
const GROUPING_MARKER = /^\s*(?:\d+ matches in \d+ files?:|\d+ files? in \d+ dirs?:)$|^\[file\]\s/m;

function countOf(text: string, pattern: RegExp): number {
	pattern.lastIndex = 0;
	let count = 0;
	for (const _match of text.matchAll(pattern)) count += 1;
	return count;
}

export interface FidelityReport {
	readonly ok: boolean;
	readonly lost: readonly string[];
}

export function checkFidelity(original: string, filtered: string, autoDetected: boolean): FidelityReport {
	const lost: string[] = [];

	// Rules: the count test only holds when the filter kept every row. rtk's grep and find grouping ELIDES repeated rows by design (`+N`), so a 300-row file whose lines say `not` legitimately comes back with 10 — measured against rtk 1.1.0, a real grouped grep of `returns not ready_N` rows went 41,739 -> 11,252 bytes and was refused as `negation: 200 -> 80`, which suppressed the compression for every search that touches code containing a negation. So the counting test is skipped when the output is grouped; the `format:` and `context:` guards below still cover the harmful grouping cases.
	// Rules: total loss is still refused even when grouped, because a group that drops every negation inverts the meaning no matter how many rows it elided.
	const grouped = GROUPING_MARKER.test(filtered);
	const negationsIn = countOf(original, NEGATION);
	const negationsOut = countOf(filtered, NEGATION);
	if (negationsIn > 0 && negationsOut === 0) lost.push(`negation: ${negationsIn} -> 0`);
	else if (!grouped && negationsOut < negationsIn) lost.push(`negation: ${negationsIn} -> ${negationsOut}`);

	// Rules: an explicit `-f grep` is rtk's grep filter, and that filter keeps only `path:line:text` rows. A result from the host's `grep` tool with `-A/-B/-C` carries `path-line-text` rows too, and every one of them is dropped (measured end-to-end: 40 context lines in, 0 out, accepted). The check runs for the explicit filter as well, because `autoDetected` is false on that path and the grouping test below would never see it.
	// Rules: no `isGrepRows` precondition — one context line per match row is still a 50% row ratio, so the majority test would wave through exactly the case that loses the most context.
	if (GROUPING_MARKER.test(filtered) && hasGrepContext(original)) {
		lost.push('context: rtk dropped the grep context lines the caller asked for');
	}

	if (autoDetected && GROUPING_MARKER.test(filtered)) {
		const rows = isGrepRows(original);
		const paths = pathLineRatio(original);
		if (!rows && paths < 0.5) lost.push('format: rtk grouped a result that was not a match list or a path list');
	}

	return {ok: lost.length === 0, lost};
}

// Rules: a find result is one path per line, so the majority test is what tells a genuine path list from a build log that happens to contain a couple of paths.
function pathLineRatio(text: string): number {
	const lines = text.split('\n').filter(line => line.trim());
	if (lines.length < 2) return 0;
	const paths = lines.filter(line => /^\s*(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|[\w.-]+[\\/])[^\s:]*$/.test(line)).length;
	return paths / lines.length;
}

/* --------------------------------------------------------------- spill */

// Rules: the host's envelope is not only at the edges. A large foreground result is truncated in the MIDDLE and given a two-line pointer there: `[... output truncated: N chars total, showing first X and last part ...]` then `[full output saved to: <path> — read it with read_file (offset/limit) or grep]` (or `[full output could not be persisted]`). Measured: a 2,951-byte pytest result carrying that pair came back from `rtk pipe` at 296 bytes with BOTH lines gone, so the model could never find the rest. The pair is lifted out before filtering and re-attached after it.
const TRUNCATION_NOTICE = /^\[\.\.\. output truncated: [^\]\n]*\]$/;
const SPILL_NOTICE = /^\[full output (?:saved to: [^\]\n]*|could not be persisted)\]$/;

function isSpillNotice(line: string): boolean {
	return TRUNCATION_NOTICE.test(line) || SPILL_NOTICE.test(line);
}

// Rules: split out of the body so rtk cannot fold them, and returned as one block so the caller can re-attach the pointer the model needs.
// Rules: a notice's line is blanked, not dropped: dropping it would join the two halves the host truncated between, and a filter that reads position (a diff hunk, a numbered list) would then see a different body.
export function extractSpillNotices(text: string): {body: string; notices: string} {
	const kept: string[] = [];
	const notices: string[] = [];
	for (const line of text.split('\n')) {
		if (isSpillNotice(line)) {
			notices.push(line);
			kept.push('');
		} else kept.push(line);
	}
	return {body: kept.join('\n'), notices: notices.join('\n')};
}

export type RtkVersion = {major: number; minor: number; patch: number};
// Rules: output is `rtk 1.0.1`; anything unparseable is null so the caller stays quiet rather than inventing a version.
export function parseRtkVersion(raw: string): RtkVersion | null {
	const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
	if (!match) return null;
	return {major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3])};
}

// Rules: a pre-1.0 binary must reach minor 25 — the release that introduced the Rewrite subcommand; any 1.x already satisfies it.
export function isSupportedVersion(version: RtkVersion | null): boolean {
	if (!version) return true;
	return version.major > 0 || version.minor >= MIN_SUPPORTED_RTK_MINOR;
}

export type RewriteVerdict =
	| {kind: 'rewrite'; command: string}
	| {kind: 'deny'; reason: string}
	| {kind: 'pass'};

// Rules: mirrors rtk's exit contract as its own source defines it — 0 AllowRewrite and 3 AskRewrite both carry a rewrite, 2 Deny carries a deny (with a message only when an rtk rule, not a host rule, blocked it), 1 Defer means no equivalent and its stdout is ignored.
// Rules: exit 3 asks the host to prompt before running the rewritten command. This host resolves permissions before `beforeToolCall` runs, so that signal cannot be forwarded here; the rewrite is applied and the host's own permission model stays the gate.
export function classifyRewrite(code: number, stdout: string, original: string): RewriteVerdict {
	const out = stdout.trim();
	if (code === 0 || code === 3) {
		return out && out !== original ? {kind: 'rewrite', command: out} : {kind: 'pass'};
	}
	if (code === 2) {
		return out ? {kind: 'deny', reason: out} : {kind: 'pass'};
	}
	return {kind: 'pass'};
}

// Rules: a command that is already rtk-prefixed, empty, or a disabled one is left alone so rewrites cannot compound.
export function shouldRewrite(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (/^rtk\s/.test(trimmed)) return false;
	if (/^RTK_DISABLED=/.test(trimmed)) return false;
	return true;
}

// Rules: `shell_command` carries an optional `args` array beside `command`, and the host runs `command + ' ' + args.shellQuoted` (verified in the bundled cli.mjs: `buildCommand2`). The rewrite must see that whole line, or a compound command is invisible: `command: 'cargo'` + `args: ['build']` asks rtk about the bare `cargo`, which has no rewrite, so the call ran unfiltered while `cargo build` rewrites fine. Measured on 12 real compound calls, every one was missed.
// Rules: the answer is split back into a command plus the caller's untouched args, so the host's own quoting still applies to them — round-tripping them through a string would have to re-quote, and rtk does not preserve the quoting it is handed (`grep -r 'a b' src/` came back unquoted).
// Rules: only a rewrite the line still *ends* with is trusted. rtk normalises some commands (`npx jest` -> `rtk jest`), and then the args suffix no longer lines up, so that rewrite is left alone rather than guessed at — a wrong split would move a caller's argument into the command.
// Rules: the args are joined RAW, not shell-quoted the way the host runs them. That is deliberate and measured against rtk 1.1.0: quoting each arg makes rtk refuse the rewrite outright (`git 'status' '--porcelain'` and `cargo 'build'` both exit 1 with no output), while the raw form rewrites cleanly. A mismatch here can only cause rtk to judge a differently-quoted line, and any rewrite that comes back is re-emitted as the untouched `command` plus the caller's own args, which the host re-quotes — so a wrong verdict can only cost the rewrite, never change what runs.
export function joinForRewrite(command: string, args: readonly string[]): {line: string; suffix: string} {
	const suffix = args.length > 0 ? ` ${args.join(' ')}` : '';
	return {line: `${command}${suffix}`, suffix};
}

// Rules: `rtk` must be a whole command word, so a `rtk-wrapper` binary or a path segment (`/tmp/rtk/git`) is not mistaken for the rewrite. The boundaries are the shell's own separators and quote characters, the same set `isCommandWordAt` uses; word boundaries alone accept both false positives.
const CARRIES_RTK = /(?:^|[\s&|;<>"'(])rtk(?=$|[\s&|;<>"')])/;

// Rules: a no-args rewrite is not `rtk ${command}` verbatim. rtk keeps a prefix (`env FOO=1 rtk …`, `nohup rtk …`, `timeout 5 rtk …`), a wrapper (`bash -c "rtk …"`), a chain (`cd src && rtk …`), or expands the subcommand (`cat README.md` -> `rtk read README.md`). Requiring exact equality dropped every one of those: measured against rtk 1.1.0, 7 of 10 representative commands were refused. The carried rewrite is accepted when it still names `rtk` at a command position, which is the same guard the args branch below uses.
export function splitRewrite(rewritten: string, command: string, suffix: string): string | null {
	if (!suffix) return CARRIES_RTK.test(rewritten) ? rewritten : null;
	if (!rewritten.endsWith(suffix)) return null;
	const rest = rewritten.slice(0, rewritten.length - suffix.length);
	// Rules: the remainder must still carry the prefix, or the split ate the whole answer (a payload that happened to equal the suffix) and the caller would run an empty command.
	return /\brtk\b/.test(rest) ? rest : null;
}

// Rules: `rtk rewrite` answers a bare `rtk …`, which the host shell resolves from ITS PATH. This mod can find rtk in a managed install dir that is not on PATH, so the bare name would run as `rtk: not found` and turn a working command into a failure. Pin each command-position `rtk` to the resolved absolute path.
// Rules: the scan walks the line once, tracking quote state, so a `rtk` inside a quoted argument is data and stays untouched (`git commit -m "use rtk"`, `echo "x | rtk y"`). A regex with an alternation over the separators cannot do this: it has no idea whether the separator it just matched sits inside a quote, and pinning there corrupts the argument (`echo "x | rtk y"` became `echo "x | '/opt/rtk' y"`).
// Rules: a command position is the start of a segment (`&&`, `||`, `;`, `|`, `&`) or a new line — rtk rewrites a multi-line block and `&` backgrounding, so both arrive from the binary itself — and either a line start, a line start after a run of `VAR=value` assignments, or one after a prefix command and its own arguments. Prefix commands are matched explicitly (`env`, `nohup`, `time`, `nice`, `command`, `exec`, `builtin`, `stdbuf`, `timeout` with its own duration) because rtk peels them rather than dropping them, and a program that merely shares the name must stay intact.
// Rules: the quote style follows the shell that will read it. POSIX shells need single quotes (with `'\''` for an embedded one); cmd.exe has no single-quote meaning at all — it would pass the quote characters through — so Windows gets a double-quoted path instead.
const PREFIX_COMMANDS = new Set(['env', 'nohup', 'time', 'nice', 'command', 'exec', 'builtin', 'stdbuf', 'timeout']);
// Rules: a flag that carries its value in a SEPARATE word must consume it (`nice -n 5`, `env -u X`, `timeout -k 1`, `time -o FILE`), or the value is left as the payload and the real command is never reached. A flag written `-o0`, `--unset=X` or `--signal=9` already carries its value and must consume none.
// Rules: `-i` and `-c` are NOT value-consuming: for `env`, `-i` is `--ignore-environment`, and for `exec`, `-c` is `-clear` (both verified: `bash -c 'exec -c echo hi'` printed `hi`, i.e. no argument was eaten). Listing either ate `rtk` as the flag's value and left the binary unpinned (measured). `stdbuf`'s `-i` is `--input=MODE` and normally written joined (`-i0`), which the joined branch handles.
const VALUE_FLAGS = new Set(['-n', '-k', '-u', '-o', '-e', '-f', '-S', '-s', '-a', '--adjustment', '--unset', '--set', '--format', '--kill-after', '--signal']);

// Rules: `rtk` must be a whole word, so `rtk-wrapper` and `myrtk` are not pinned.
function isCommandWordAt(line: string, start: number): boolean {
	const next = line[start + 3];
	return line.startsWith('rtk', start) && (next === undefined || /[\s&|;<>]/.test(next));
}

function skipSpaces(text: string, start: number): number {
	let index = start;
	while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index += 1;
	return index;
}

// Rules: skip past the prefix commands and assignments in front of a command, returning the index the payload starts at. Stops at the first word that is neither, so the caller compares that word against `rtk`. Only a flag that starts with `-` is a flag: without that guard `time rtk git status` had `rtk` eaten as `time`'s option and the rewrite was never pinned.
function skipPrefixes(line: string, start: number): number {
	let index = start;
	for (;;) {
		index = skipSpaces(line, index);
		const rest = line.slice(index);
		// Rules: `FOO=1` is tested before the bare word, because the word pattern would otherwise match its `FOO` and stop the scan at an assignment.
		const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+/.exec(rest);
		if (assignment) {
			index += assignment[0].length;
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
		if (!word || !PREFIX_COMMANDS.has(word)) return index;
		index += word.length;
		for (;;) {
			index = skipSpaces(line, index);
			const flag = /^-{1,2}[^\s]+/.exec(line.slice(index))?.[0];
			if (!flag) break;
			index += flag.length;
			if (VALUE_FLAGS.has(flag) && !flag.includes('=')) {
				index = skipSpaces(line, index);
				const value = /^\S+/.exec(line.slice(index))?.[0];
				if (value) index += value.length;
			}
		}
		// Rules: `timeout` takes a bare duration after its flags, which is neither a flag nor the payload.
		if (word === 'timeout') {
			index = skipSpaces(line, index);
			const duration = /^[0-9.]+[A-Za-z]*/.exec(line.slice(index))?.[0];
			if (duration) index += duration.length;
		}
	}
}

// Rules: rtk rewrites a shell wrapper's script rather than the wrapper, so `bash -c "git status"` comes back as `bash -c "rtk git status"` — the `rtk` sits INSIDE a quoted argument, where the main scan treats it as data and leaves it bare. Measured: with rtk installed outside the host shell's `PATH`, that rewrote a working command into `bash: rtk: command not found`. The script is pinned instead, and the quote style is converted when needed so the inner single quotes survive.
const SHELL_WRAPPERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);

// Rules: the closing quote, with backslash escapes honoured only inside double quotes — a single-quoted POSIX string has no escapes at all.
function findClosingQuote(text: string, open: number, quote: string): number {
	for (let index = open + 1; index < text.length; index += 1) {
		if (quote === '"' && text[index] === '\\') {
			index += 1;
			continue;
		}
		if (text[index] === quote) return index;
	}
	return -1;
}

// Rules: a script that EXPANDS — `$`, a backtick, or a backslash — cannot be moved into double quotes without changing what it does, so a single-quoted one that expands is left exactly as rtk emitted it rather than silently altered. A double-quoted script already accepts the inner single quotes unchanged.
function hasExpansion(script: string): boolean {
	return /[$`\\]/.test(script);
}

// Rules: rtk emits `env FOO=1 bash -c …`, `nohup bash -c …` and `timeout 5 bash -c …`, so the wrapper is found at a command position AFTER the prefixes are skipped, and `-c` may be combined with other single-letter flags (`-ec`).
// Rules: `-c` must be a real flag of the wrapper, not the tail of a word, so the scan reads whole flags and checks for the letter.
function wrapperScriptAt(text: string, start: number): {scriptStart: number; scriptEnd: number; quote: string} | null {
	const word = /^[A-Za-z_][\w.-]*/.exec(text.slice(start))?.[0];
	if (!word || !SHELL_WRAPPERS.has(word)) return null;
	let index = start + word.length;
	let sawC = false;
	for (;;) {
		const at = skipSpaces(text, index);
		const flag = /^--?[A-Za-z][\w-]*/.exec(text.slice(at))?.[0];
		if (!flag) {
			index = at;
			break;
		}
		if (!flag.startsWith('--') && flag.slice(1).includes('c')) sawC = true;
		index = at + flag.length;
	}
	if (!sawC) return null;
	const open = skipSpaces(text, index);
	const quote = text[open];
	if (quote !== '"' && quote !== "'") return null;
	const close = findClosingQuote(text, open, quote);
	if (close === -1) return null;
	return {scriptStart: open + 1, scriptEnd: close, quote};
}

export function pinBinary(command: string, bin: string, platform: string = process.platform): string {
	const quoted = platform === 'win32'
		? `"${bin.replace(/"/g, '""')}"`
		: `'${bin.replace(/'/g, `'\\''`)}'`;
	// Rules: the wrapper pass runs first, then the normal scan. It recurses through the public entry so a nested wrapper is pinned too, and so `win32` quoting is not duplicated here.
	const pin = (text: string) => pinBinary(text, bin, platform);
	let out = '';
	let index = 0;
	// Rules: the command position is true at the start of the string and again after a separator, so the scan carries one flag instead of re-deriving it from a lookbehind.
	let atCommand = true;
	while (index < command.length) {
		const char = command[index] ?? '';
		// Rules: a wrapper's script is a command line in its own right, so `rtk` inside it is at a command position even though the quotes make it an argument here. Measured: `bash -c "rtk git status"` left the inner `rtk` bare, so with rtk outside the host shell's PATH a working command became `bash: rtk: command not found`.
		if (atCommand && platform !== 'win32') {
			const script = wrapperScriptAt(command, index);
			if (script) {
				const inner = command.slice(script.scriptStart, script.scriptEnd);
				const pinnedInner = pin(inner);
				const requote = script.quote === '"' || !hasExpansion(inner);
				if (pinnedInner !== inner && requote) {
					// Rules: the script is re-emitted inside double quotes, because a single-quoted container cannot hold the `'\''` escaping a POSIX path may need. `scriptStart` is one past the opening quote, so the replacement begins at that quote.
					out += `${command.slice(index, script.scriptStart - 1)}"${pinnedInner}"`;
					index = script.scriptEnd + 1;
					atCommand = false;
					continue;
				}
			}
		}
		if (char === "'" || char === '"') {
			// Rules: copy the quoted span verbatim — no pinning, no separator state inside it.
			const end = findClosingQuote(command, index, char);
			const stop = end === -1 ? command.length : end + 1;
			out += command.slice(index, stop);
			index = stop;
			continue;
		}
		if (atCommand && isCommandWordAt(command, index)) {
			out += quoted;
			index += 3;
			atCommand = false;
			continue;
		}
		if (atCommand) {
			const payload = skipPrefixes(command, index);
			if (payload !== index) {
				out += command.slice(index, payload);
				index = payload;
				continue;
			}
			if (isCommandWordAt(command, index)) {
				out += quoted;
				index += 3;
				atCommand = false;
				continue;
			}
			atCommand = false;
		}
		if (char === '\\' && command[index + 1] === '\n') {
			out += '\\\n';
			index += 2;
			continue;
		}
		if (char === '\n' || char === '&' || char === '|' || char === ';') {
			out += char;
			index += 1;
			// Rules: `||` and `&&` both end a segment; one flag is enough, so a second separator is consumed by the copy above.
			atCommand = true;
			continue;
		}
		out += char;
		index += 1;
	}
	return out;
}

// Rules: grouping is applied by hand because toLocaleString varies with the host locale, so the message would differ per machine.
function grouped(value: number): string {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const GUIDANCE = `RTK is active: command output is condensed before it reaches you. The facts that matter are kept — the failing test name, the assertion, the file and line. A grouped file or match list may print \`+N\` for repeated names it elided: that many entries were dropped, and when no \`rtk recall\` hint follows they were not stored. Re-run a command unfiltered (or narrow its pattern) when you need every name, when its result is empty although output was clearly expected, when it contradicts its exit code, or when it is garbled; do that with \`rtk bypass <cmd>\` or \`RTK_DISABLED=1 <cmd>\`, not by dropping the prefix yourself.

Call rtk directly for what the automatic rewrite cannot express: \`rtk read <file> --level aggressive\` for an overview, \`rtk smart <file>\` for two lines, \`rtk err <cmd>\` for errors only, \`rtk log <file>\` to dedupe, \`rtk json <file> --keys-only\` for shape, \`rtk deps\`, \`rtk diff\`, \`rtk env\`, \`rtk test <cmd>\`, and \`rtk find . -name '*.ts'\`. Do not type \`rtk\` in front of a command that is already rewritten for you.

Condensed output states its own recovery path. An elided span prints a count such as \`+50\`, and when the full text was kept it also prints a hint naming \`rtk recall <hash>\`; use that hint rather than re-running the command, which can be slow or have side effects. When there is a count but no hash the elided entries were not stored — narrow the pattern or re-read the specific file or range instead of re-running the whole command. \`rtk gain\` reports what rtk has saved; \`rtk discover\` finds past commands it could have condensed.`;

// Rules: exported so a test can check every named subcommand against the installed binary instead of trusting the prose.
export function guidanceText(): string {
	return GUIDANCE;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('rtk', {type: 'string', default: '', description: 'Start mode: on|off (default: off)'});
	cmd.addFlag('rtk-bin', {type: 'string', default: '', description: 'Absolute path to the rtk binary (default: probe PATH, then ~/.local/bin, ~/.bun/bin, ~/.cargo/bin)'});
	cmd.addFlag('rtk-filter', {type: 'boolean', default: true, description: 'Condense grep/glob tool output'});
	cmd.addFlag('rtk-shell', {type: 'boolean', default: true, description: 'Condense shell output that no rewrite covered'});

	let mode = readOwnMode(cmd.store, OFF, value => value === 'on' || value === 'off');

	// Rules: the host registers every mod, THEN applies `--mod-option` values (verified against the bundled host: buildHost runs loadMods before setFlagValue). A `getFlag` in the factory therefore answers the default, so `rtk-bin` must be resolved lazily — on the first hook or command — or the user's explicit path is silently ignored.
	// Rules: the probe runs once and is cached; an explicit path wins over the probe, and an empty flag leaves the probe as the only answer.
	let binCache: {value: string | null} | undefined;
	function binPath(): string | null {
		binCache ??= {value: String(cmd.getFlag('rtk-bin') ?? '').trim() || resolveBin('rtk')};
		return binCache.value;
	}

	// Rules: an explicit `--mod-option rtk-bin=…` is never probed, so a typo used to be reported as the binary and the guidance block promised rewrites that could never run. Both sources get one existence and executable check here; resolution itself stays unverified so a path that appears later still works. This answer gates status, guidance, and every process spawn.
	function binUsable(): boolean {
		const bin = binPath();
		if (!bin) return false;
		try {
			accessSync(bin, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	// Rules: the rewrite is judged against the session's rules, so it runs in the session cwd; a deny file above it is found the same way rtk finds it for any other host.
	const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;

	let version: RtkVersion | null = null;
	let versionProbe: Promise<void> | null = null;
	// undefined means undecided; a mode change clears it so a re-enable decides again.
	let guidanceDecided: boolean | undefined;
	const supported = () => isSupportedVersion(version);
	const versionNote = () => {
		if (!binUsable()) return 'binary: NOT FOUND';
		if (!version) return `binary: ${binPath()}`;
		const label = `${version.major}.${version.minor}.${version.patch}`;
		return supported() ? `binary: ${label}` : `binary: ${label} (too old — need >= 0.${MIN_SUPPORTED_RTK_MINOR}.0)`;
	};
	// Rules: one probe per session. onSessionStart runs fire-and-forget, so the first round would otherwise spawn a second `rtk --version` while the first is still in flight; memoising keeps it to one.
	const versionSettled = () => {
		versionProbe ??= readVersion();
		return versionProbe;
	};

	function setMode(next: string): void {
		mode = next;
		guidanceDecided = undefined;
		writeOwnMode(cmd.store, next);
		announceMode(cmd.events);
	}

	cmd.expose('setMode', (next: unknown) => {
		if (typeof next !== 'string') return false;
		const value = next.trim().toLowerCase();
		if (value !== 'on' && value !== 'off') return false;
		setMode(value);
		return true;
	});
	cmd.expose('getMode', () => mode);
	// Rules: the stored mode says what the user asked for, not what the session can do. `compress` prints one line for three mods, so it needs to know that `rtk=on` condenses nothing without a usable, new-enough binary — otherwise that line claims a capability the session does not have. The reason is returned rather than a bare boolean, because "no binary" and "too old" call for different fixes.
	cmd.expose('inactiveReason', () => (!binUsable() ? 'no binary' : !supported() ? `rtk too old, needs >= 0.${MIN_SUPPORTED_RTK_MINOR}.0` : null));

	// Rules: `cmd.exec` accepts no timeout (it ignores the option), so abort through a signal or a hung rtk blocks the tool call forever.
	async function exec(options: {command: string; args: string[]}, timeoutMs: number) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await cmd.exec({...options, cwd, signal: controller.signal});
		} finally {
			clearTimeout(timer);
		}
	}

	async function readVersion(): Promise<void> {
		const bin = binPath();
		if (!bin) return;
		try {
			const {stdout} = await exec({command: bin, args: ['--version']}, REWRITE_TIMEOUT_MS);
			version = parseRtkVersion(stdout);
		} catch {
			version = null;
		}
	}

	async function rewrite(command: string): Promise<RewriteVerdict> {
		const bin = binPath();
		if (!bin || !supported()) return {kind: 'pass'};
		try {
			const {stdout, code} = await exec({command: bin, args: ['rewrite', command]}, REWRITE_TIMEOUT_MS);
			return classifyRewrite(code, stdout, command);
		} catch {
			return {kind: 'pass'};
		}
	}

	// Rules: `rtk pipe` reads stdin and exec has no stdin, so the text goes to a temp file and is redirected in.
	// Rules: never pass tool output through a heredoc — a line equal to the delimiter would run as shell.
	// Rules: an omitted filter lets rtk auto-detect; it is an identity pass when nothing matches and `never_worse` refuses anything larger than the input.
	async function filterThroughRtk(filter: string | null, text: string): Promise<string | null> {
		const bin = binPath();
		if (!bin) return null;
		let dir: string | undefined;
		try {
			dir = mkdtempSync(join(tmpdir(), 'cmd-compress-'));
			const file = join(dir, 'in.txt');
			writeFileSync(file, text, 'utf8');
			const shell = filterShell();
			// Rules: cmd.exe re-parses its /c line and nested quotes do not survive it, so the redirect goes in a batch file and only that path reaches the command line.
			let scriptPath: string | undefined;
			if (shell.wrap) {
				scriptPath = join(dir, 'run.cmd');
				writeFileSync(scriptPath, windowsPipeScript(bin, filter, file), 'utf8');
			}
			const {stdout, code} = await exec(pipeCommand(bin, filter, file, shell, scriptPath), FILTER_TIMEOUT_MS);
			if (code !== 0) return null;
			const out = stdout;
			if (!out.trim() || out.length >= text.length) return null;
			return out;
		} catch {
			return null;
		} finally {
			if (dir) rmSync(dir, {recursive: true, force: true});
		}
	}

	// Rules: only the body is condensed; the host's own header and trailer are re-attached verbatim, so an exit status or a truncation notice cannot be folded away.
	// Rules: colour is removed from the body whether or not the rtk pass below succeeds. rtk keeps escapes, so a result it declines would otherwise arrive at full size and still carry 33% of bytes that mean nothing — the strip alone is the win on those, and it is why the byte floor is checked after it, not before.
	// Rules: the spill pointer rides in the MIDDLE of the result, so it is lifted out before filtering and put back after. The host writes it where the elision happened; a result that lost it leaves the model with no way to reach the rest of the output, which was measured: a 2,951-byte pytest result came back at 296 bytes with both pointer lines gone.
	async function condense(toolName: string, filter: string | null, text: string): Promise<string | null> {
		// Rules: the shape is read from the original result, because the split below removes the very header it looks for.
		const shapeFilter = filterForShape(toolName, filter, text);
		const {head, body, tail} = splitSegments(toolName, text);
		const plainBody = stripAnsi(body);
		// Rules: the no-filter paths keep the body as it was, so a pointer that rode in the middle stays exactly where the host put it. Only the filtered path has to move it, because the bytes it referred to are gone.
		const plainResult = () => {
			const plain = `${head}${plainBody}${tail}`;
			return plain.length < text.length ? plain : null;
		};
		if (plainBody.trim().length < MIN_FILTER_BYTES) return plainResult();
		const {body: filterable, notices} = extractSpillNotices(plainBody);
		const filtered = await filterThroughRtk(shapeFilter, filterable);
		if (!filtered) return plainResult();
		// Rules: a shorter result is not automatically a safe one. The filter is rejected when it grouped content that was neither a match list nor a path list (a wrong format guess), or when it dropped a negation, so the model keeps the original rather than a summary that lies.
		const fidelity = checkFidelity(filterable, filtered, shapeFilter === null);
		if (!fidelity.ok) return plainResult();
		// Rules: rtk's never-worse guard covers the body it saw, not the envelope and notices re-attached here; with two notices the joins can add a byte. The mod promises never-worse, so an inflated result falls back to the stripped original.
		const next = `${head}${notices ? `${filtered}\n${notices}` : filtered}${tail}`;
		return next.length < text.length ? next : plainResult();
	}

	function textOf(result: unknown): string | null {
		if (!Array.isArray(result) || result.length === 0) return null;
		const parts = result as Array<{type?: string; text?: string}>;
		if (parts.some(part => part?.type !== 'text')) return null;
		return parts.map(part => part.text ?? '').join('\n');
	}

	// Rules: a shell call rtk already rewrote had its output filtered by rtk, so condensing it again would spend a second process for nothing.
	const rewrittenCalls = new Set<string>();

	// Rules: without an id the pair cannot be matched, so the filter errs toward skipping the second pass rather than double-filtering.
	const wasRewritten = (toolCallId: unknown) =>
		typeof toolCallId === 'string' && rewrittenCalls.delete(toolCallId);

	cmd.addCommand({
		name: 'rtk',
		description: 'Toggle RTK condensed command output for this session',
		argumentHint: '[on|off|gain|status]',
		handler: async ({args}) => {
			const arg = args.trim().toLowerCase();
			if (arg === 'gain') {
				const bin = binPath();
				if (!bin) return {message: 'rtk binary not found — install rtk, then /reload.'};
				try {
					const {stdout, code} = await exec({command: bin, args: ['gain', '-f', 'json']}, FILTER_TIMEOUT_MS);
					if (code !== 0) return {message: 'rtk gain is unavailable in this build.'};
					const parsed = JSON.parse(stdout) as {
						summary?: {total_commands?: number; total_saved?: number; total_input?: number; avg_savings_pct?: number};
					};
					const s = parsed.summary;
					if (!s) return {message: 'rtk gain returned no summary.'};
					const saved = Number(s.total_saved) || 0;
					const pct = Number(s.avg_savings_pct) || 0;
					return {
						message: `RTK saved ${grouped(saved)} tokens over ${grouped(Number(s.total_commands) || 0)} commands (${pct.toFixed(1)}%).`,
					};
				} catch {
					return {message: 'Could not read rtk gain.'};
				}
			}
			if (!arg || arg === 'status') {
				return {message: `RTK: ${mode} (${versionNote()})`};
			}
			if (arg !== 'on' && arg !== 'off') return {message: 'Usage: /rtk [on|off|gain|status]'};
			setMode(arg);
			if (arg === 'on' && !binUsable()) return {message: 'RTK on, but the rtk binary was not found. Install it, then /reload.'};
			if (arg === 'on' && !supported()) return {message: `RTK on, but ${versionNote()}. Upgrade rtk — rewrites fall back to raw until then.`};
			return {message: `RTK ${arg}.`};
		},
	});

	cmd.hooks({
		// Rules: a flag is a per-session override, applied when the host binds — getFlag answers the default at factory time.
		onSessionStart: () => {
			const flag = String(cmd.getFlag('rtk') ?? '').trim().toLowerCase();
			if (flag === 'on' || flag === 'off') {
				mode = flag;
				guidanceDecided = undefined;
				announceMode(cmd.events);
			}
			void versionSettled();
		},

		// Rules: the block must be byte-stable across rounds or the provider's prompt-prefix cache misses every turn, so the decision is taken once and reused for the session. A mode change is the one legitimate reason for the block to change, and it is a durable input the caller actually changed.
		// Rules: the version probe is awaited before the decision. `onSessionStart` starts it fire-and-forget, so the first round used to decide on `null`, and `isSupportedVersion(null)` grants the benefit of the doubt — measured: an rtk 0.0.1 session was told to use rtk for rewrites that can never run, and the wrong answer was then cached for the whole session. Awaiting keeps the bytes stable and makes them correct: the promise is memoised, so only the first call waits at all.
		appendSystemPrompt: async () => {
			if (mode === OFF || !binPath()) return undefined;
			await versionSettled();
			// Rules: the mode can change while the probe runs, in which case there is nothing left to inject.
			if (mode === OFF) return undefined;
			guidanceDecided ??= binUsable() && supported();
			return guidanceDecided ? wrapBlock('rtk', GUIDANCE) : undefined;
		},

		// Rules: `normal mode` ends EVERY mode, so a session where rtk is the only mod loaded must still answer it; caveman and ponytail normally handle it first, and the host stops the chain at the first `handled`.
		transformInput: ({text}) => {
			if (text.trim().toLowerCase() !== NORMAL_MODE) return undefined;
			turnOffSiblings(cmd.use, 'rtk');
			setMode(OFF);
			return {action: 'handled', message: 'All compression modes off.'};
		},

		beforeToolCall: async ({toolCallId, toolName, input}) => {
			const bin = binPath();
			if (mode === OFF || !isShellTool(toolName) || !bin || !binUsable() || !supported()) return undefined;
			const command = typeof input.command === 'string' ? input.command : '';
			if (!shouldRewrite(command)) return undefined;
			// Rules: the host appends `args` after shell-quoting them, so the rewrite is asked about the whole line and split back only when the answer still ends with the caller's own suffix. `powershell` has no args field, so this is empty there.
			const args = Array.isArray(input.args) ? (input.args as unknown[]).filter((a): a is string => typeof a === 'string') : [];
			const {line, suffix} = joinForRewrite(command, args);
			const verdict = await rewrite(line);
			// Rules: a deny message is rtk's own pipeline rule, not a host rule, so the call must not run — pass the reason on as the result.
			if (verdict.kind === 'deny') {
				return {block: true, additionalContext: `Blocked by an rtk rule: ${verdict.reason}`};
			}
			if (verdict.kind !== 'rewrite') return undefined;
			const rewrittenCommand = splitRewrite(verdict.command, command, suffix);
			if (rewrittenCommand === null) return undefined;
			if (typeof toolCallId === 'string' && toolCallId) rewrittenCalls.add(toolCallId);
			return {input: {...input, command: pinBinary(rewrittenCommand, bin)}};
		},

		afterToolCall: async ({toolCallId, toolName, result, isError}) => {
			// Rules: the marker is consumed on entry, before any guard that returns early, so a rewritten call whose output was too small or errored leaves no id behind. The value is captured once and read by the shell pass below, so consuming early cannot lose the answer this call needs.
			if (rewrittenCalls.size > 256) rewrittenCalls.clear();
			const alreadyRewritten = wasRewritten(toolCallId);
			if (mode === OFF || isError) return undefined;
			const text = textOf(result);
			if (text === null) return undefined;

			// Rules: the byte floor and the binary gate the rtk spawn, not the colour strip. A 900-byte coloured result was rejected here before, so the escapes — the only thing this pass can remove for free — reached the model; the strip costs nothing without a process. A binary that is missing or too old must not spawn, and must not suppress the strip either.
			// Rules: the flag that turns filtering off is checked per tool below, because a caller can disable grep/glob filtering and keep the shell pass.
			const plain = stripAnsi(text);
			const stripped = plain.length < text.length ? {content: [{type: 'text', text: plain}]} : undefined;

			// An explicit filter for a tool result that is not shell output.
			const filter = filterNameFor(toolName);
			if (filter) {
				if (cmd.getFlag('rtk-filter') === false || !supported() || !binUsable()) return stripped;
				if (text.length < MIN_FILTER_BYTES) return stripped;
				const filtered = await condense(toolName, filter, text);
				return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
			}

			// Shell output with no rewrite is still auto-detected: `npm test` output can be cargo-shaped.
			if (!isShellTool(toolName)) return undefined;
			if (cmd.getFlag('rtk-shell') === false || !supported() || !binUsable()) return stripped;
			// Rules: a rewritten call is skipped because rtk already filtered it — except when rtk declined and left its faithful baseline, which `canRefilterCompressed` recognises. Anything carrying a recovery hint stays skipped, so a recall hash is never dropped.
			// Rules: the shape test reads the plain text. `path:line:text` rows with an escape before the column still match the row pattern, but a styled `+3 more files` marker would not — testing the raw bytes could let a marked result through the second pass and drop its recall hash.
			if (alreadyRewritten && !canRefilterCompressed(plain)) {
				// Rules: rtk filtered the body but keeps every colour escape, so the strip still applies here. It deletes only escapes, which carry no information, so the envelope and every fact survive.
				return stripped;
			}
			if (text.length < MIN_FILTER_BYTES) return stripped;
			const filtered = await condense(toolName, null, text);
			return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
		},
	});
}

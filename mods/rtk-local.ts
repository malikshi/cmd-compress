// rtk-local — body parsers, local condensers, fidelity checks, and host-envelope splitting.
// exports: Segments, findTrailer, isGrepRows, hasGrepContext, canRefilterCompressed, condenseGrepRows, condenseCountRows, condensePaths, filterNameFor, filterForShape, splitSegments, stripAnsi, FidelityReport, checkFidelity, extractSpillNotices, removeTree
// used_by: mods/rtk.ts, bench/output.ts, test/mods.test.ts, test/rtk-shapes.test.ts, test/bench.test.ts
// related: mods/rtk.ts, mods/rtk-cli.ts
// rules: every parser fails open — a body that is not the expected shape returns null and the caller keeps the original text.
// rules: never return a reassembled result larger than the original; both layouts are measured before either is rendered.
// rules: ANSI is stripped on every path, because colour carries no fact and no binary is needed for the strip.
// rules: a rewritten call is re-filtered only when it carries no recovery marker and is still a majority match list.
// agent: unknown | xai | 2026-11-06 | unknown | split out of mods/rtk.ts after review (F1); no behaviour change

import {rmSync} from 'node:fs';
import {isShellTool} from './shared.ts';

const FILTER_BY_TOOL: Record<string, string> = {grep: 'grep', glob: 'find'};

// Rules: owned-key lookup only. `FILTER_BY_TOOL[name]` walks the prototype chain, so a tool named `toString` or `constructor` answers a function, which would reach `rtk pipe -f` as the filter name and spawn a pointless process for a name rtk does not know.
export function filterNameFor(toolName: string): string | undefined {
	return Object.hasOwn(FILTER_BY_TOOL, toolName) ? FILTER_BY_TOOL[toolName] : undefined;
}


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
// Rules: the rows are recognised by the same parser the condensers use — `path:line:text` with a path that looks like a file — and a majority is required, so a diff, a log, or a build log that happens to contain one such line is not mistaken for a match list. A timestamped log line (`2026-11-04 12:00:01: INFO…`) is refused here too; the loose shape test alone read it as a row and let a second filter pass replace the log with a grouped summary.
// Rules: a Windows match row is `C:\src\a.ts:12:text`; the drive colon is consumed explicitly so the rest of the path may not hide one. A bare `.*` would also read `http://host:8080:x` as a row. `grepBodyRow` owns the path check so this test cannot drift from `condenseGrepRows`.
// Rules: this runs on every shell result, and a 700 KB body costs 40 ms of per-line regex — the answer is false almost every time. Two cheap native passes replace most of that: a body with no `:<digits>:` anywhere cannot hold a single row, and the loop bails as soon as the remaining lines can no longer reach the 0.5 majority. Both preserve the exact rule; neither changes a true answer.
const ROW_HINT = /:\d+:/;

// Rules: context detection uses the loose shape, not the strict file-like check. A real host path can be a dotless `Makefile`, a `.env`, a directory with a space, or a non-ASCII path; a false negative here accepts rtk's grouping and drops every context row. A false positive only refuses a grouping, so it cannot lose data.
// Rules: a Windows match row is `C:\src\a.ts:12:text`; the drive colon is consumed explicitly so the rest of the path may not hide one.
const GREP_ROW = /^((?:[A-Za-z]:[\\/])?[^\s:][^:\n]*):\d+:[^\n]*$/;

export function isGrepRows(text: string): boolean {
	if (!ROW_HINT.test(text)) return false;
	const lines = text.split('\n').filter(line => line.trim());
	if (lines.length < 2) return false;
	let rows = 0;
	for (let index = 0; index < lines.length; index += 1) {
		if (grepBodyRow(lines[index] ?? '')) rows += 1;
		else if ((rows + lines.length - index - 1) / lines.length < 0.5) return false;
	}
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


// Rules: rtk's own `grep` filter is its weakest path. Measured against 1.1.0: 20 files x 5 hits came back 6,850 -> 6,591 (3%), 30 files x 1 hit 1,671 -> 1,671 (0%), a 400-row count-mode body 17,140 -> 14,331 (16%). It groups by file but repeats the path and the whole match text on every row. This condenser groups AND dedupes the text, so identical lines collapse to one row with their line numbers joined — 75%, 56% and 85% on the same three inputs — and it never drops a file.
// Rules: the row parser is stricter than `GREP_ROW` on purpose: any non-blank line that is not `path:line:text` makes the whole body ineligible, so a build log that happens to hold a few match rows is never regrouped. That also means a `-A/-B/-C` context row opts the body out for free, matching the explicit `hasGrepContext` refusal.
// Rules: the path must look like a file — a separator, or a dot before the colon — because this pass also sees shell output, and a log line is `2026-11-04 12:00:01: INFO started`, which a bare pattern reads as path `2026-11-04 12`, line `00`, text `01: INFO started`. Measured: 40 such lines were regrouped into one bogus file, losing every timestamp. A real match path carries `src/` or `.ts` before its first colon. A body with no such row anywhere is refused, so that log is returned untouched.
// Rules: the cap only elides repeated *rows* inside one file, never a file, and never a whole directory. Every path still gets named, so the model can always see which files matched, and the dropped count is stated.
// Rules: both layouts keep rtk's own recovery marker (`N matches in MF:`) so a grouped result is never fed back through the filter, and so `+N` reads the way the model already learned.
// Rules: the shape and the "looks like a file" test are SPLIT — one linear match, then a constant-time path check. They used to be a single alternation with two overlapping `[^:\n]*` repeats around a lazy tail, which is exponential on a dotted line: measured 122 ms at 63 chars, 31 ms at 57, 698 ms at 5.6 KB, and a timeout past that. One grep hit inside a minified bundle is exactly such a line, and this ran on every grep, glob and shell result.
const GREP_BODY_SHAPE = /^((?:[A-Za-z]:)?[^:\n]+):(\d+):([^\n]*)$/;

// Rules: the two shapes a match path really takes — a name after a separator (`src/a.ts`, `C:\a\b.ts`, `./x.ts`), or a bare `name.ext`. A bare `2026-11-04 12` has neither, which is what refuses the timestamp log.
// Rules: these are the old alternation's branches, written out instead of backtracked. The separator branch keeps its original constraint — everything BEFORE the first separator must be word characters, which is what refuses `a b/c.ts` — while the part after it stays free, so `src/my dir/f.ts` is still a match.
const WORD_PREFIX = /^[\w.$@+-]*$/;
const DOTTED_NAME = /^[^:\s/\\]+(?:\.[^:\s/\\]+)+$/;

function looksLikeFilePath(path: string): boolean {
	if (!path) return false;
	if (path.length > 2 && path[1] === ':' && (path[2] === '/' || path[2] === '\\')) return true;
	const sep = path.search(/[\\/]/);
	if (sep >= 0) return sep < path.length - 1 && WORD_PREFIX.test(path.slice(0, sep));
	return DOTTED_NAME.test(path);
}

// Rules: one row parse for both condensers, so the path condenser's "this is a grep row, leave it to the row condenser" refusal cannot drift from the row condenser's own acceptance.
function grepBodyRow(line: string): [path: string, number: string, text: string] | null {
	const match = GREP_BODY_SHAPE.exec(line);
	if (!match) return null;
	const [, path, number, text] = match as unknown as [string, string, string, string];
	return looksLikeFilePath(path) ? [path, number, text] : null;
}

interface GrepGroup {
	readonly numbers: string[];
	readonly text: string;
}

// Rules: a layout appends lines to an array instead of returning a joined string, so its byte length can be measured without building the string. Both layouts used to be joined in full and then compared, so a body producing two ~1 MB renderings paid for both and kept one.
// Rules: the sink is a plain `string[]`, never a callback. A callback sink gave every `sink(...)` call site two different closure shapes (measure vs join), and V8 deoptimised `condenseGrepRows` and both layouts on `wrong call target` / `Insufficient type feedback` on every large body — measured as a bimodal 137 ms / 900 ms distribution on 2 MB. The array form is monomorphic and removed the spread.
type LineSink = string[];

// Rules: the byte length of `lines.join('\n') + '\n'` without joining: the content, plus one separator per line (n-1 between, 1 trailing).
function sinkLength(lines: readonly string[]): number {
	let content = 0;
	for (const line of lines) content += line.length;
	return content + lines.length;
}

// Rules: two layouts, both keeping every file name, and the smaller one wins. `[file] path (N):` pays a constant per file and a tab-indented row per line, which wins when a file has several hits; the `path:  (N)` directory tree pays one directory line and lists `name:numbers:text`, which wins when most files hold a single hit and a per-file header would add more than the row it introduces. Measured: the directory tree takes a 240-files-one-hit-each body from 0% to 23% and a 30-files-one-hit body from 30% to 58%, while the file-header layout stays ahead on a file with 20 hits (77% vs 75%) — so neither dominates and both are built.
// Rules: both layouts read the SAME pre-deduped structures. They used to dedupe independently, so a body was deduped twice and each layout rebuilt the per-file `Map` — profiled on a 40k-row body that was 27% of the run.
function eachFileLine(sink: LineSink, order: readonly string[], groupsByFile: ReadonlyMap<string, GrepGroup[]>, rowCount: ReadonlyMap<string, number>, perFileCap: number, total: number): void {
	sink.push(`${total} matches in ${order.length}F:`);
	for (const path of order) {
		const groups = groupsByFile.get(path) ?? [];
		const rows = rowCount.get(path) ?? 0;
		const shown = groups.slice(0, perFileCap);
		sink.push(`[file] ${path} (${rows}):`);
		for (const group of shown) sink.push(`  ${group.numbers.join(',')}:${group.text}`);
		const keptRows = shown.reduce((sum, group) => sum + group.numbers.length, 0);
		if (rows > keptRows) sink.push(`  +${rows - keptRows} more lines in this file`);
	}
}

// Rules: the path is split on its last separator, so a Windows drive colon never becomes a directory boundary, and a relative root file lands under `./`.
function eachDirLine(sink: LineSink, order: readonly string[], groupsByFile: ReadonlyMap<string, GrepGroup[]>, rowCount: ReadonlyMap<string, number>, perFileCap: number, total: number): void {
	const dirs: string[] = [];
	const filesByDir = new Map<string, string[]>();
	for (const path of order) {
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		const dir = slash >= 0 ? path.slice(0, slash + 1) : './';
		let files = filesByDir.get(dir);
		if (!files) {
			files = [];
			filesByDir.set(dir, files);
			dirs.push(dir);
		}
		files.push(path);
	}
	sink.push(`${total} matches in ${order.length}F:`);
	for (const dir of dirs) {
		const paths = filesByDir.get(dir) ?? [];
		sink.push(`${dir}  (${paths.length})`);
		for (const path of paths) {
			const name = dir === './' && !path.includes('/') && !path.includes('\\') ? path : path.slice(dir.length);
			const groups = groupsByFile.get(path) ?? [];
			const rows = rowCount.get(path) ?? 0;
			const shown = groups.slice(0, perFileCap);
			for (const group of shown) sink.push(`  ${name}:${group.numbers.join(',')}:${group.text}`);
			const keptRows = shown.reduce((sum, group) => sum + group.numbers.length, 0);
			// Rules: the count is ROWS, not groups, because the line it prints says `lines`. Counting groups understated it whenever a file repeated one match text on several lines, and the two layouts reported different numbers for the same elision.
			if (rows > keptRows) sink.push(`  ${name}: +${rows - keptRows} more lines`);
		}
	}
}

// Rules: a reshape that saves almost nothing is not worth it — it spends the model's attention on a new layout for a byte or two, and it rewrites a diagnostic shape it may misread. Measured: a `file:line:col: message` linter listing parsed as match rows and came back 2,389 -> 2,340 (2%), so anything under 5% is declined and left exactly as it was. Real grep wins clear this by a wide margin (a 240-files-one-hit body is the floor at 9.8%).
const MIN_LOCAL_GAIN = 0.05;

function worthIt(original: string, condensedLength: number): boolean {
	return condensedLength < original.length * (1 - MIN_LOCAL_GAIN);
}

export function condenseGrepRows(text: string, perFileCap = 6): string | null {
	const order: string[] = [];
	// Rules: dedupe happens as each row arrives, so no intermediate per-row record is kept. The old shape built a `GrepRow[]` per file and deduped it into a second structure; on a 40k-row body that was 4.4 MB of short-lived objects out of ~23 MB allocated for a 1 MB result, and the GC cost of it is what made the peak 5-6x the median on the large bodies. `rowCount` is kept separately because the elided count is measured in ROWS while the groups are measured in distinct texts.
	const groupsByFile = new Map<string, GrepGroup[]>();
	const indexByFile = new Map<string, Map<string, number>>();
	const rowCount = new Map<string, number>();
	let total = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const row = grepBodyRow(line);
		if (!row) return null;
		const [path, number, body] = row;
		let groups = groupsByFile.get(path);
		let index = indexByFile.get(path);
		if (!groups || !index) {
			groups = [];
			index = new Map<string, number>();
			groupsByFile.set(path, groups);
			indexByFile.set(path, index);
			rowCount.set(path, 0);
			order.push(path);
		}
		rowCount.set(path, (rowCount.get(path) ?? 0) + 1);
		total += 1;
		const at = index.get(body);
		if (at === undefined) {
			index.set(body, groups.length);
			groups.push({numbers: [number], text: body});
		} else groups[at]?.numbers.push(number);
	}
	if (total < 2) return null;

	// Rules: measure first, render once. Both layouts are rendered into arrays (cheap: one push per line, no string join), the winner is picked on exact byte length, and only that one is joined. The lossy choice is therefore made once and the losing rendering never becomes a string.
	const renderings: LineSink[] = [[], []];
	eachFileLine(renderings[0]!, order, groupsByFile, rowCount, perFileCap, total);
	eachDirLine(renderings[1]!, order, groupsByFile, rowCount, perFileCap, total);
	let best: LineSink | null = null;
	let bestLength = Number.POSITIVE_INFINITY;
	for (const lines of renderings) {
		const length = sinkLength(lines);
		if (!worthIt(text, length)) continue;
		if (length < bestLength) {
			bestLength = length;
			best = lines;
		}
	}
	return best === null ? null : `${best.join('\n')}\n`;
}

// Rules: the host's count mode is `path:count` — measured in `finishCountMode`: `compactPath(n.path):n.count`. `grepBodyRow` cannot recognise it (it needs a third field), so before this pass existed the row reached the path tree and printed `file0.ts:1`, putting the match COUNT exactly where a line number goes; a model reading that reopens the wrong line, and nothing downstream could tell the two apart. It is condensed by its own layout instead of being refused, because rtk's grep filter leaves this shape byte-identical and its find filter prints the count with no label at all.
// Rules: a count is never emitted without a word beside it. The directory line states `N files, M hits` and every row prints `name (count)`, so no position in the output can be read as a line number. The per-directory cap elides file rows and prints `+N files`; it never drops a directory.
// Rules: the header is the `N files in M dirs:` form `condensePaths` emits, so `GROUPING_MARKER` recognises the result as grouped and a count body whose names happen to contain a negation word is not refused by the negation test.
const COUNT_BODY_SHAPE = /^((?:[A-Za-z]:)?[^:\n]+):(\d+)$/;

function countBodyRow(line: string): [path: string, count: number] | null {
	const match = COUNT_BODY_SHAPE.exec(line);
	if (!match) return null;
	const [, path, count] = match as unknown as [string, string, string];
	if (!looksLikeFilePath(path)) return null;
	const value = Number(count);
	return Number.isSafeInteger(value) ? [path, value] : null;
}

// Rules: a path repeated across rows is merged into ONE entry whose count is the sum. Listing it once per row made the output claim more files than exist (`10 files` over five names) and printed the same name several times, so the model reads phantom files; a repeated path is reachable because a paged or concatenated count body produces one. The distinct path count, not the row count, is what the header and each directory line report.
export function condenseCountRows(text: string, perDirCap = 6): string | null {
	const order: string[] = [];
	const countsByDir = new Map<string, Array<{name: string; count: number}>>();
	const indexByDir = new Map<string, Map<string, number>>();
	let files = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const row = countBodyRow(line.trim());
		if (!row) return null;
		const [path, count] = row;
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		const dir = slash >= 0 ? path.slice(0, slash + 1) : './';
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		let bucket = countsByDir.get(dir);
		let index = indexByDir.get(dir);
		if (!bucket || !index) {
			bucket = [];
			index = new Map<string, number>();
			countsByDir.set(dir, bucket);
			indexByDir.set(dir, index);
			order.push(dir);
		}
		const at = index.get(name);
		if (at === undefined) {
			index.set(name, bucket.length);
			bucket.push({name, count});
			files += 1;
		} else {
			const entry = bucket[at];
			if (entry) bucket[at] = {name: entry.name, count: entry.count + count};
		}
	}
	if (files < 2) return null;

	const out: string[] = [`${files} files in ${order.length} dirs:`];
	for (const dir of order) {
		const bucket = countsByDir.get(dir) ?? [];
		const dirHits = bucket.reduce((sum, entry) => sum + entry.count, 0);
		out.push(`${dir}  (${bucket.length} files, ${dirHits} hits)`);
		for (const entry of bucket.slice(0, perDirCap)) out.push(`  ${entry.name} (${entry.count})`);
		if (bucket.length > perDirCap) out.push(`  +${bucket.length - perDirCap} files`);
	}
	const joined = `${out.join('\n')}\n`;
	return worthIt(text, joined.length) ? joined : null;
}

// Rules: rtk's `find` filter groups by directory but elides whole directories once it has printed enough: on a 60-directory glob it named 19 of 60, so the model cannot tell which directories matched at all. This condenser prints every directory, caps only the file list inside one directory, and states the elided file count. Measured 82-84% on a 260- and a 300-path glob versus rtk's 73-77%, and it needs no process.
// Rules: a body that is not one clean path per line is refused, so a shell listing with prose is never folded into a path tree. A `path:line:text` row is refused explicitly even though it passes `PATH_ROW` (a colon is not whitespace): the path condenser would read the line number and the match text as part of the file name and drop both. That case is `condenseGrepRows`' job, and when it declines the body is left for rtk.
// Rules: a `path:count` row is refused here too, for the same reason as the match row — `10` is a match count and the tree would print it where a line number belongs. `condenseCountRows` owns that shape.
const COUNT_ROW = /:(\d+)$/;
const PATH_ROW = /^\s*(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]|[\w.$@+-]+[\\/])[^\s]*$/;

export function condensePaths(text: string, perDirCap = 6): string | null {
	const order: string[] = [];
	const filesByDir = new Map<string, string[]>();
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		if (GLOB_HEAD.test(`${line}\n`)) continue;
		if (!PATH_ROW.test(line) || grepBodyRow(line.trim()) || COUNT_ROW.test(line.trim())) return null;
		const path = line.trim();
		const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		const dir = slash >= 0 ? path.slice(0, slash + 1) : './';
		const name = slash >= 0 ? path.slice(slash + 1) : path;
		let files = filesByDir.get(dir);
		if (!files) {
			files = [];
			filesByDir.set(dir, files);
			order.push(dir);
		}
		files.push(name);
	}
	const total = [...filesByDir.values()].reduce((sum, files) => sum + files.length, 0);
	if (total < 2) return null;

	const out: string[] = [`${total} files in ${order.length} dirs:`];
	for (const dir of order) {
		const files = filesByDir.get(dir) ?? [];
		out.push(`${dir}  (${files.length})`);
		for (const file of files.slice(0, perDirCap)) out.push(`  ${file}`);
		if (files.length > perDirCap) out.push(`  +${files.length - perDirCap} files`);
	}
	const joined = `${out.join('\n')}\n`;
	return worthIt(text, joined.length) ? joined : null;
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
	// Rules: normalise CRLF once, here, because every parser below splits on `\n` and a retained `\r` breaks each of them: the `$`-anchored notice test stops matching (the `[cwd change to …]` note was left in the body and the earlier of two consecutive notices was lost), `PATH_ROW`'s `[^\s]*$` refuses every line, and condensed match rows keep a stray `\r` inside their text. Windows shell and ripgrep output is CRLF, so this was every Windows result. The segments are rebuilt here anyway, so they come back LF; the model reads text, not bytes.
	text = text.replace(/\r\n/g, '\n');
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


// Rules: a test runner or a build tool emits colour by default, and rtk's filters pass the escapes straight through — measured on 10,110 bytes of realistic coloured test output, rtk returned all 10,110 bytes with all 720 escapes intact, while the same text without them was 6,750 bytes (33.2% smaller). Colour carries nothing the model reads, so it is removed before anything else.
// Rules: only text-carrying sequences are matched — CSI (colour, cursor), OSC (titles, hyperlinks, clipboard writes) and the two-byte escapes. Anything else is left alone rather than eaten by a pattern wide enough to swallow real output.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

// Rules: the fast path matters — every large result goes through here, and most have no escape at all.
export function stripAnsi(text: string): string {
	return text.includes('\u001B') ? text.replace(ANSI, '') : text;
}


// Rules: rtk's own byte guard (`never_worse`) only asks whether the output got smaller, never whether it still says the same thing, and its auto-detect can pick the wrong filter. Measured against the real binary: a cargo-style block of 20 `error[E0xx]: cannot find value …` lines plus context came back from `rtk pipe` as 156 bytes reading `20 matches in 1F:` then `[file] --> src/lib.rs (20):` — every one of the 20 error messages was gone, with no recovery hint. The same text is what an agent needs to fix a build.
// Rules: the guard targets that failure, not an ideal of lossless compression. A readable filter summarises on purpose — `FAILURES (1): 1. tests::fails_here` is a good result — so the check is format-shaped instead of atom-by-atom: when rtk auto-detected and produced its grep/find grouping while the original was neither `path:line:text` rows nor a path list, the guess was wrong and the original is kept. Negation loss is refused too, since that inverts meaning and no legitimate summariser drops one.
const NEGATION = /\b(?:not|no|never|without|cannot|can't|don't|doesn't|didn't|isn't|aren't|won't|wouldn't|shouldn't|couldn't|neither|nor)\b/gi;
// Rules: the guard catches rtk's grouped form — a `N matches in M files:` header or a `[file] path:` block header — because that is what its grep/find filters emit when they summarise.
// Rules: the abbreviated `NF:` spelling is rtk's own (`pipe_cmd.rs`) and this mod's own local condenser emits it too, so it must count as grouped here. Without it, a legitimately elided block (which states its `+N`) was refused as `negation: 12 -> 1` and the 80% saving was lost on any search whose code contains a negation.
const GROUPING_MARKER = /^\s*(?:\d+ matches in \d+(?: files?|F):|\d+ files? in \d+ dirs?:)$|^\[file\]\s/m;

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


// Rules: the host's envelope is not only at the edges. A large foreground result is truncated in the MIDDLE and given a two-line pointer there: `[... output truncated: N chars total, showing first X and last part ...]` then `[full output saved to: <path> — read it with read_file (offset/limit) or grep]` (or `[full output could not be persisted]`). Measured: a 2,951-byte pytest result carrying that pair came back from `rtk pipe` at 296 bytes with BOTH lines gone, so the model could never find the rest. The pair is lifted out before filtering and re-attached after it.
const TRUNCATION_NOTICE = /^\[\.\.\. output truncated: [^\]\n]*\]$/;
const SPILL_NOTICE = /^\[full output (?:saved to: [^\]\n]*|could not be persisted)\]$/;

function isSpillNotice(line: string): boolean {
	return TRUNCATION_NOTICE.test(line) || SPILL_NOTICE.test(line);
}

// Rules: split out of the body so rtk cannot fold them, and returned as one block so the caller can re-attach the pointer the model needs.
// Rules: a notice's line is blanked, not dropped: dropping it would join the two halves the host truncated between, and a filter that reads position (a diff hunk, a numbered list) would then see a different body.
// Rules: the marker pre-check is the whole cost of this call on a normal result. Almost no result was truncated, but every result goes through here, and the split+join below is 31 ms on a 700 KB body — paid twice per result, since the local pass and the rtk pass each call it. Native `includes` over the raw text answers "no notice" for a fraction of a millisecond, and the output is byte-identical because rejoining the split lines returns the input.
const SPILL_MARKERS = ['[... output truncated', '[full output '];

export function extractSpillNotices(text: string): {body: string; notices: string} {
	if (!SPILL_MARKERS.some(marker => text.includes(marker))) return {body: text, notices: ''};
	const kept: string[] = [];
	const notices: string[] = [];
	// Rules: split on `\r?\n`. Windows shell and ripgrep output is CRLF, and a retained `\r` fails the `$`-anchored notice test, so the truncation pointer would be left in the body for the filter to delete.
	for (const line of text.split(/\r?\n/)) {
		if (isSpillNotice(line)) {
			notices.push(line);
			kept.push('');
		} else kept.push(line);
	}
	return {body: kept.join('\n'), notices: notices.join('\n')};
}

// Rules: the temp dir is a cache, never a result. A cleanup failure — a Windows file lock, a scanner holding the directory — must not replace a condensed result with a thrown hook, so it is swallowed here; the OS clears the directory later. The remover is a parameter only so the guard is reachable from a test without a real filesystem failure.
export function removeTree(dir: string, remove: (path: string) => void = path => rmSync(path, {recursive: true, force: true})): void {
	try {
		remove(dir);
	} catch {
		// Rules: a leftover temp dir is harmless; a throw out of afterToolCall is not.
	}
}

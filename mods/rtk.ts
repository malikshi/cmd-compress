// rtk — condensed command output: rewrites shell_command through `rtk rewrite`, condenses the output a rewrite cannot cover, and filters grep/glob results.
// exports: default (ModFactory), REWRITE_TIMEOUT_MS, MIN_FILTER_BYTES, MIN_SUPPORTED_RTK_MINOR, shouldRewrite, pinBinary, splitSegments, filterNameFor, parseRtkVersion, isSupportedVersion, classifyRewrite, guidanceText
// used_by: package.json (commandcode.mods), mods/compress.ts, bench/output.ts, test/rtk-shapes.test.ts, test/mods.test.ts
// related: mods/shared.ts
// rules: fail open on every path — a missing binary, an abort, an unexpected exit code, or a malformed payload leaves the original untouched.
// rules: exit 2 is a deny from rtk's own contract: a message on stdout names the rule that blocked it, so it becomes a block; empty means a Claude-only deny rule the host does not own, so it passes.
// rules: the host's own envelope — a `Found N files` header, a pagination notice, an `Exit code:` line — is split off before filtering and re-attached after. The head is re-attached byte-for-byte; the tail keeps its notice text exactly, with the blank run before it capped at one line. rtk folds those as noise; they carry the count, the truncation, and the failure.
// rules: the emitted `rtk` is pinned to the resolved absolute path. rtk often lives in ~/.bun/bin, which the host shell may not have on PATH, so a bare name would turn a working command into `rtk: not found`.
// agent: 2026-11-02 ported from rtk-ai/rtk hooks/pi/rtk.ts and tersio extensions/rtk
// agent: 2026-11-02 honour exit 2 as a deny, add auto-detect output condensing for unrewritten shell calls, drop the ignored exec `timeout` for an AbortController, add gain + version reporting
// agent: 2026-11-03 envelope-preserving filter (splitSegments + condense), pinBinary against off-PATH rtk, drop the dead `rg` mapping, consume the rewritten-call marker before every early return

import type {ModApi} from '@commandcode/harness';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {filterShell, NORMAL_MODE, pipeCommand, readOwnMode, resolveBin, turnOffSiblings, wrapBlock, writeOwnMode, OFF} from './shared.ts';

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

// Rules: the last lines of a Command Code result often carry the truth the body hides: `[Showing results with pagination = …]` and `(Results are truncated: showing 1-100 of 382 …)` mean the list is incomplete, `(Search timed out …)` means it may be wrong, and `Command aborted` means it did not finish. rtk folds all of them away as noise, so they are cut off before the filter and re-attached after it.
// Rules: anchored to the end of the whole result, not to any line end — a notice that merely appears mid-output is body text and must be filtered with it.
const TRAILER = new RegExp(
	'\\n*(?:' +
		'\\[Showing results with pagination = [^\\]\\n]*\\]' +
		'|\\(Results are truncated: [^)\\n]*\\)' +
		'|\\(Search timed out[^)\\n]*\\)' +
		'|Found \\d+ total occurrences? across \\d+ files?\\.' +
		'|Command (?:aborted|timed out after \\d+\\s?ms)' +
		')[\\s]*$',
);

// Rules: `formatShellCommandResult` puts the exit status and the signal on the first lines, before any output.
const SHELL_HEAD = /^(?:(?:Exit code|Signal):[^\n]*\n)+/;

// Rules: `glob` prints `Found N files` and then one indented path per line. The find filter reads that header line as a path, so it is split off rather than fed in.
const GLOB_HEAD = /^Found \d+ files?[^\n]*\n/;

// Rules: a result is split into the envelope the host wrote and the body rtk should condense; only the body is ever filtered, so no host information is lost.
// Rules: the tail keeps the host's own separator, capped at one blank line — enough to keep the notice visually separate without carrying a run of blank lines the filter just folded.
function tailFrom(matched: string): string {
	const blank = matched.startsWith('\n\n') ? '\n\n' : '\n';
	return `${blank}${matched.trimStart()}`;
}

export function splitSegments(toolName: string, text: string): Segments {
	if (toolName === 'glob') {
		const head = GLOB_HEAD.exec(text);
		if (head) {
			const rest = text.slice(head[0].length);
			const trailer = TRAILER.exec(rest);
			if (!trailer) return {head: head[0], body: rest, tail: ''};
			return {head: head[0], body: rest.slice(0, trailer.index), tail: tailFrom(trailer[0])};
		}
	}
	const trailer = TRAILER.exec(text);
	if (trailer) {
		const body = text.slice(0, trailer.index);
		const head = SHELL_HEAD.exec(body);
		const tail = tailFrom(trailer[0]);
		return head ? {head: head[0], body: body.slice(head[0].length), tail} : {head: '', body, tail};
	}
	if (toolName === 'shell_command') {
		const head = SHELL_HEAD.exec(text);
		if (head) return {head: head[0], body: text.slice(head[0].length), tail: ''};
	}
	return {head: '', body: text, tail: ''};
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

// Rules: `rtk rewrite` answers a bare `rtk …`, which the host shell resolves from ITS PATH. This mod can find rtk in ~/.bun/bin when that directory is not on PATH, so the bare name would run as `rtk: not found` and turn a working command into a failure. Pin each command-position `rtk` to the resolved absolute path.
// Rules: a command position is the start of a segment (`&&`, `||`, `;`, `|`), the first word after a run of `VAR=value` assignments, and the first word after a prefix command and its own arguments — rtk emits all three (`FOO=1 rtk ls`, `env FOO=1 rtk git status`, `time rtk git status`, `timeout 5 rtk git status`) because it rewrites the payload of a prefix rather than dropping it. Each prefix is matched explicitly so a program named `timeout` that is not a prefix stays intact. An argument that merely contains the word (`git commit -m "use rtk"`) is data and stays untouched.
// Rules: the quote style follows the shell that will read it. POSIX shells need single quotes (with `'\''` for an embedded one); cmd.exe has no single-quote meaning at all — it would pass the quote characters through — so Windows gets a double-quoted path instead.
const PREFIX_COMMAND = '(?:env|nohup|time|nice|command|stdbuf)(?:[ \\t]+-{0,2}[A-Za-z0-9=_,.:/-]+)*[ \\t]+|timeout(?:[ \\t]+-{0,2}[A-Za-z0-9=_,.:/-]+)*[ \\t]+[0-9.]+[A-Za-z]*[ \\t]+';

export function pinBinary(command: string, bin: string, platform: string = process.platform): string {
	const quoted = platform === 'win32'
		? `"${bin.replace(/"/g, '""')}"`
		: `'${bin.replace(/'/g, `'\\''`)}'`;
	const assignments = '(?:[ \\t]*[A-Za-z_][A-Za-z0-9_]*=\\S+[ \\t]+)*';
	return command.replace(
		new RegExp(`(^|&&|\\|\\||[;|])([ \\t]*(?:${PREFIX_COMMAND})?${assignments})rtk(?=[ \\t]|$)`, 'g'),
		(_match, lead: string, before: string) => `${lead}${before}${quoted}`,
	);
}

// Rules: grouping is applied by hand because toLocaleString varies with the host locale, so the message would differ per machine.
function grouped(value: number): string {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const GUIDANCE = `RTK is active: command output is condensed before it reaches you. Every signal survives — the failing test name, the assertion, the file and line. Treat a condensed result as complete. Re-run a command unfiltered only when its result is empty when output was clearly expected, contradicts its exit code, or is garbled; do that with \`rtk bypass <cmd>\` or \`RTK_DISABLED=1 <cmd>\`, not by dropping the prefix yourself.

Call rtk directly for what the automatic rewrite cannot express: \`rtk read <file> --level aggressive\` for an overview, \`rtk smart <file>\` for two lines, \`rtk err <cmd>\` for errors only, \`rtk log <file>\` to dedupe, \`rtk json <file> --keys-only\` for shape, \`rtk deps\`, \`rtk diff\`, \`rtk env\`, \`rtk test <cmd>\`, and \`rtk find . -name '*.ts'\`. Do not type \`rtk\` in front of a command that is already rewritten for you.

Condensed output states its own recovery path. An elided span prints a count such as \`+50\`, and when the full text was kept it also prints a hint naming \`rtk recall <hash>\`; use that hint rather than re-running the command, which can be slow or have side effects. When there is a count but no hash the elided lines were not stored — re-read the specific file or range instead of re-running the whole command. \`rtk gain\` reports what rtk has saved; \`rtk discover\` finds past commands it could have condensed.`;

// Rules: exported so a test can check every named subcommand against the installed binary instead of trusting the prose.
export function guidanceText(): string {
	return GUIDANCE;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('rtk', {type: 'string', default: '', description: 'Start mode: on|off (default: off)'});
	cmd.addFlag('rtk-filter', {type: 'boolean', default: true, description: 'Condense grep/glob tool output'});
	cmd.addFlag('rtk-shell', {type: 'boolean', default: true, description: 'Condense shell output that no rewrite covered'});

	let mode = readOwnMode(cmd.store, OFF, value => value === 'on' || value === 'off');

	const bin = resolveBin('rtk');

	// Rules: the rewrite is judged against the session's rules, so it runs in the session cwd; a deny file above it is found the same way rtk finds it for any other host.
	const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;

	let version: RtkVersion | null = null;
	const supported = () => isSupportedVersion(version);
	const versionNote = () => {
		if (!bin) return 'binary: NOT FOUND';
		if (!version) return `binary: ${bin}`;
		const label = `${version.major}.${version.minor}.${version.patch}`;
		return supported() ? `binary: ${label}` : `binary: ${label} (too old — need >= 0.${MIN_SUPPORTED_RTK_MINOR}.0)`;
	};

	function setMode(next: string): void {
		mode = next;
		writeOwnMode(cmd.store, next);
	}

	cmd.expose('setMode', (next: unknown) => {
		if (typeof next !== 'string') return false;
		const value = next.trim().toLowerCase();
		if (value !== 'on' && value !== 'off') return false;
		setMode(value);
		return true;
	});
	cmd.expose('getMode', () => mode);

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
		if (!bin) return;
		try {
			const {stdout} = await exec({command: bin, args: ['--version']}, REWRITE_TIMEOUT_MS);
			version = parseRtkVersion(stdout);
		} catch {
			version = null;
		}
	}

	async function rewrite(command: string): Promise<RewriteVerdict> {
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
		if (!bin) return null;
		let dir: string | undefined;
		try {
			dir = mkdtempSync(join(tmpdir(), 'cmd-compress-'));
			const file = join(dir, 'in.txt');
			writeFileSync(file, text, 'utf8');
			const {stdout, code} = await exec(pipeCommand(bin, filter, file, filterShell()), FILTER_TIMEOUT_MS);
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
	async function condense(toolName: string, filter: string | null, text: string): Promise<string | null> {
		const {head, body, tail} = splitSegments(toolName, text);
		if (body.trim().length < MIN_FILTER_BYTES) return null;
		const filtered = await filterThroughRtk(filter, body);
		if (!filtered) return null;
		return `${head}${filtered}${tail}`;
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
			if (arg === 'on' && !bin) return {message: 'RTK on, but the rtk binary was not found. Install it, then /reload.'};
			if (arg === 'on' && !supported()) return {message: `RTK on, but ${versionNote()}. Upgrade rtk — rewrites fall back to raw until then.`};
			return {message: `RTK ${arg}.`};
		},
	});

	cmd.hooks({
		// Rules: a flag is a per-session override, applied when the host binds — getFlag answers the default at factory time.
		onSessionStart: () => {
			const flag = String(cmd.getFlag('rtk') ?? '').trim().toLowerCase();
			if (flag === 'on' || flag === 'off') mode = flag;
			void readVersion();
		},

		appendSystemPrompt: () => (mode === OFF || !bin || !supported() ? undefined : wrapBlock('rtk', GUIDANCE)),

		// Rules: `normal mode` ends EVERY mode, so a session where rtk is the only mod loaded must still answer it; caveman and ponytail normally handle it first, and the host stops the chain at the first `handled`.
		transformInput: ({text}) => {
			if (text.trim().toLowerCase() !== NORMAL_MODE) return undefined;
			turnOffSiblings(cmd.use, 'rtk');
			setMode(OFF);
			return {action: 'handled', message: 'All compression modes off.'};
		},

		beforeToolCall: async ({toolCallId, toolName, input}) => {
			if (mode === OFF || toolName !== 'shell_command' || !bin || !supported()) return undefined;
			const command = typeof input.command === 'string' ? input.command : '';
			if (!shouldRewrite(command)) return undefined;
			const verdict = await rewrite(command);
			// Rules: a deny message is rtk's own pipeline rule, not a host rule, so the call must not run — pass the reason on as the result.
			if (verdict.kind === 'deny') {
				return {block: true, additionalContext: `Blocked by an rtk rule: ${verdict.reason}`};
			}
			if (verdict.kind !== 'rewrite') return undefined;
			if (typeof toolCallId === 'string' && toolCallId) rewrittenCalls.add(toolCallId);
			return {input: {...input, command: pinBinary(verdict.command, bin)}};
		},

		afterToolCall: async ({toolCallId, toolName, result, isError}) => {
			// Rules: the marker is consumed on entry, before any guard that returns early, so a rewritten call whose output was too small or errored leaves no id behind. The value is captured once and read by the shell pass below, so consuming early cannot lose the answer this call needs.
			if (rewrittenCalls.size > 256) rewrittenCalls.clear();
			const alreadyRewritten = wasRewritten(toolCallId);
			if (mode === OFF || isError || !supported()) return undefined;
			const text = textOf(result);
			if (text === null || text.length < MIN_FILTER_BYTES) return undefined;

			// An explicit filter for a tool result that is not shell output.
			const filter = filterNameFor(toolName);
			if (filter) {
				if (cmd.getFlag('rtk-filter') === false) return undefined;
				const filtered = await condense(toolName, filter, text);
				return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
			}

			// Shell output rtk did not rewrite still gets auto-detected: `npm test` has no rewrite but cargo-style output does.
			if (toolName !== 'shell_command') return undefined;
			if (cmd.getFlag('rtk-shell') === false) return undefined;
			if (alreadyRewritten) return undefined;
			const filtered = await condense(toolName, null, text);
			return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
		},
	});
}

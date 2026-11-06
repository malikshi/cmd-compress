// rtk-cli — rtk version and rewrite verdicts, command-line pinning, and guidance blocks.
// exports: RtkVersion, RewriteVerdict, MIN_SUPPORTED_RTK_MINOR, parseRtkVersion, isSupportedVersion, classifyRewrite, shouldRewrite, joinForRewrite, splitRewrite, pinBinary, guidanceText, subAgentGuidance
// used_by: mods/rtk.ts, test/mods.test.ts, test/mods.behaviour.test.ts
// related: mods/shared.ts
// rules: pin every command-position `rtk` to the resolved absolute path; a bare name is not on a GUI host's PATH.
// rules: the quote style follows the shell that reads it — POSIX single quotes, cmd.exe double quotes.
// rules: mirror rtk's exit contract: 0 and 3 rewrite, 2 denies only with a message, everything else passes.
// agent: unknown | xai | 2026-11-06 | unknown | split out of mods/rtk.ts after review (F1); no behaviour change

// Rules: `rtk rewrite` first appears in 0.25.0 — verified against the upstream tree, where v0.24.0 has no Rewrite subcommand and v0.25.0 does. An older binary fails every rewrite open, so say so instead of pretending to work.
export const MIN_SUPPORTED_RTK_MINOR = 25;

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

// Rules: a value may be quoted (`FOO="a b"`), escaped (`FOO=a\ b`), or contain a quote, and `\S*` stopped at the first space inside the quotes: rtk emits `FOO="a b" rtk …`, so the inner `rtk` stayed bare and failed off PATH. Scan the value as a shell word, then continue to the command.
function assignmentLength(text: string): number | null {
	const prefix = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text);
	if (!prefix) return null;
	let index = prefix[0].length;
	while (index < text.length) {
		const char = text[index] ?? '';
		if (char === '"' || char === "'") {
			index += 1;
			while (index < text.length) {
				const next = text[index] ?? '';
				if (char === '"' && next === '\\') {
					index += 2;
					continue;
				}
				index += 1;
				if (next === char) break;
			}
			continue;
		}
		if (char === '\\') {
			index += 2;
			continue;
		}
		if (char === '\n' || char === '\r' || char === ';' || char === '&' || char === '|') return null;
		if (char === ' ' || char === '\t') {
			while (text[index] === ' ' || text[index] === '\t') index += 1;
			return index;
		}
		index += 1;
	}
	return null;
}

// Rules: skip past the prefix commands and assignments in front of a command, returning the index the payload starts at. Stops at the first word that is neither, so the caller compares that word against `rtk`. Only a flag that starts with `-` is a flag: without that guard `time rtk git status` had `rtk` eaten as `time`'s option and the rewrite was never pinned.
function skipPrefixes(line: string, start: number): number {
	let index = start;
	for (;;) {
		index = skipSpaces(line, index);
		const rest = line.slice(index);
		// Rules: the assignment scanner runs before the bare word, because the word pattern would otherwise match its `FOO` and stop the scan at an assignment.
		const assignment = assignmentLength(rest);
		if (assignment !== null) {
			index += assignment;
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

export function pinBinary(command: string, bin: string, platform: string = process.platform, escapeForOuter = false): string {
	const posix = `'${bin.replace(/'/g, `'\\''`)}'`;
	const quoted = platform === 'win32'
		? `"${bin.replace(/"/g, '""')}"`
		: escapeForOuter
			? posix.replace(/[\\"$`]/g, '\\$&')
			: posix;
	// Rules: the wrapper pass runs first, then the normal scan. It recurses through the public entry so a nested wrapper is pinned too, and so `win32` quoting is not duplicated here.
	const pinNormal = (text: string) => pinBinary(text, bin, platform, false);
	const pinOuter = (text: string) => pinBinary(text, bin, platform, true);
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
				// Rules: a nested single-quoted script inside a double-quoted outer script cannot hold a pinned POSIX path without another layer of escaping, and a wrong guess corrupts the command line. Leave that inner `rtk` bare rather than emit a broken line; the next pass over a top-level script still pins it.
				if (escapeForOuter && script.quote === "'") {
					out += command.slice(index, script.scriptEnd + 1);
					index = script.scriptEnd + 1;
					atCommand = false;
					continue;
				}
				const pinnedInner = script.quote === '"' ? pinOuter(inner) : pinNormal(inner);
				const requote = script.quote === '"' || !hasExpansion(inner);
				if (pinnedInner !== inner && requote) {
					// Rules: the script is re-emitted inside double quotes, because a single-quoted container cannot hold the `'\''` escaping a POSIX path may need. A single-quoted script has no expansion of its own, so every `"`, `\`, `$` and backtick in the pinned form is escaped for the outer double quotes. A double-quoted script keeps its own escapes and expansions, so only the pinned path is escaped; without that, a path containing `$` or a backtick was expanded by the outer shell. When this pass is already inside an outer double-quoted script, its own delimiters are escaped too, or the nested script closes the outer container and the command is corrupted.
					const requoted = script.quote === '"' ? pinnedInner : pinnedInner.replace(/[\\"$`]/g, '\\$&');
					const delimiter = escapeForOuter ? '\\"' : '"';
					out += `${command.slice(index, script.scriptStart - 1)}${delimiter}${requoted}${delimiter}`;
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
const GUIDANCE = `RTK is active: command output is condensed before it reaches you. The facts that matter are kept — the failing test name, the assertion, the file and line. A grouped file or match list may print \`+N\` for repeated names it elided: that many entries were dropped, and when no \`rtk recall\` hint follows they were not stored. Re-run a command unfiltered (or narrow its pattern) when you need every name, when its result is empty although output was clearly expected, when it contradicts its exit code, or when it is garbled; do that with \`rtk bypass <cmd>\` or \`RTK_DISABLED=1 <cmd>\`, not by dropping the prefix yourself.

Call rtk directly for what the automatic rewrite cannot express: \`rtk read <file> --level aggressive\` for an overview, \`rtk smart <file>\` for two lines, \`rtk err <cmd>\` for errors only, \`rtk log <file>\` to dedupe, \`rtk json <file> --keys-only\` for shape, \`rtk deps\`, \`rtk diff\`, \`rtk env\`, \`rtk test <cmd>\`, and \`rtk find . -name '*.ts'\`. Do not type \`rtk\` in front of a command that is already rewritten for you.

Condensed output states its own recovery path. An elided span prints a count such as \`+50\`, and when the full text was kept it also prints a hint naming \`rtk recall <hash>\`; use that hint rather than re-running the command, which can be slow or have side effects. When there is a count but no hash the elided entries were not stored — narrow the pattern or re-read the specific file or range instead of re-running the whole command. \`rtk gain\` reports what rtk has saved; \`rtk discover\` finds past commands it could have condensed.`;

// Rules: exported so a test can check every named subcommand against the installed binary instead of trusting the prose.
// Rules: a direct rtk command must name the resolved absolute binary. This block is injected when the binary is usable, including a managed install that is off PATH — the same case `pinBinary` exists for — so a bare `rtk read` in the examples would fail exactly where the block is needed. The block stays byte-stable per session because the path is fixed once resolved.
// Rules: a binary path may contain a backtick, and a one-backtick span would be cut short by it; the fence is always one longer than the longest run inside the path.
function codeSpan(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	return `${fence}${text}${fence}`;
}

export function guidanceText(bin?: string, platform: string = process.platform): string {
	if (!bin) return GUIDANCE;
	const quoted = pinBinary('rtk', bin, platform);
	return `The resolved rtk binary is ${codeSpan(quoted)}; use it for every direct rtk command below.\n\n${GUIDANCE.replace(/`rtk ([a-z-]+)([^`\n]*)`/g, (_match, name: string, rest: string) => codeSpan(`${quoted} ${name}${rest}`))}`;
}

// Rules: a sub-agent never receives this mod, so nothing rewrites its shell calls. The parent cannot rewrite them either — its hooks only see its own tool calls, and the child's tool call ids never reach them. The one lever left is the `agent` call's prompt: tell the child to prefix commands itself, with the absolute path this mod resolved, because a bare `rtk` is exactly what `pinBinary` exists to avoid (rtk ships to ~/.local/bin, often off a GUI host's PATH).
// Rules: this is a nudge, not a rewrite, and the measured compliance is partial — across 24 shell calls in four real headless delegations on 1.88.3, 14 (58%) used the prefix and the spread ran 0% to 80% depending on how much the task itself pointed at commands. A child may also call the block "an environment hint" and run everything bare, or comply by ALSO re-running unfiltered to double-check (which is the RTK_DISABLED advice working). So the block must never be described as enforcement, and there is no stronger mechanism available: a child's `systemPrompt` comes from its definition and `agentDefinitions()` is host-internal, so a mod cannot extend it.
// Rules: the path is emitted through `pinBinary` so it arrives shell-quoted, for the same measured reason the rewrite path does. Raw, a path with a space breaks the line the child is told to type: `/opt/my tools/rtk git status` ran as `sh: /opt/my: not found`, and Windows puts rtk under `C:\Program Files\` by default.
// Rules: the wording must not reuse GUIDANCE. That block says output is condensed *for* the reader and forbids typing `rtk` yourself — both false in a child, where nothing is rewritten unless the child does it.
// Rules: the block tells the child that the prefixed command IS the run, not a second opinion. Measured: children that complied often ran the command bare AND prefixed "so both outputs are reported" — twice the processes and twice the turns for one answer, and the bare run's output is exactly the ones the prefix was supposed to keep out of context. The `RTK_DISABLED=1` advice stays for the one case that justifies a re-run, an output that looks wrong or folded too far, so the escape hatch is still named rather than removed.
export function subAgentGuidance(bin: string, platform: string = process.platform): string {
	const quoted = pinBinary('rtk', bin, platform);
	return `RTK is available here, but this sub-agent's own shell calls are NOT rewritten automatically — no hook reaches a sub-agent run. Prefix each command with ${quoted} so its output is condensed before you read it: \`${quoted} git status\`, \`${quoted} cargo build\`, \`${quoted} npm test\`. The prefixed command IS the run — do not also run it bare to compare, and never prefix the same command twice; that doubles the work and puts the full output back in context. It keeps the failing test name, the assertion, the file and line, and may fold repeated paths into \`+N\`. Re-run one unfiltered with \`RTK_DISABLED=1 <cmd>\` only when a result looks wrong or you need every name.`;
}

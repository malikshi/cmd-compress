// rtk — condensed command output: rewrites shell_command through `rtk rewrite`, condenses the output a rewrite cannot cover, and filters grep/glob results.
// exports: default, REWRITE_TIMEOUT_MS, MIN_FILTER_BYTES
// used_by: package.json (commandcode.mods), mods/compress.ts, bench/output.ts, test/rtk-shapes.test.ts, test/mods.test.ts, test/mods.behaviour.test.ts
// related: mods/shared.ts, mods/rtk-cli.ts, mods/rtk-local.ts
// rules: fail open on every path — a missing binary, an abort, an unexpected exit code, or a malformed payload leaves the original untouched.
// rules: exit 2 is a deny from rtk's own contract: a message on stdout names the rule that blocked it, so it becomes a block; empty means a host-only deny rule, so it passes.
// rules: the host's envelope — `Found N files`, a pagination notice, an `Exit code:` line — is split off before filtering and re-attached after, so its count, truncation, and failure survive.
// rules: never return a reassembled result larger than the original; the envelope and re-attached notices can add bytes the body filter never saw.
// rules: `shell_command` and `powershell` are both shell tools with the same result envelope, so every path keys off `isShellTool`.
// rules: a rewritten shell call skips the second filter unless rtk declined to compress it and left its faithful baseline.
// rules: the rewrite cache key carries the rule-file stamp, because a rewrite cached before a rule edit would skip the new deny. Only rewrites are cached.
// rules: a sub-agent run gets no mod hooks, so the `agent` call's prompt is the only channel; it is added only with a usable, new-enough binary.
// rules: `shell_command`'s `args` array is part of the line the host runs, so the rewrite sees it; a `-A/-B/-C` result is never handed to rtk's grep filter.
// agent: unknown | unknown | 2026-11-05 | unknown | sub-agent path proved end-to-end on 1.88.3; compliance measured at 38/60 prefixed child calls
// agent: unknown | xai | 2026-11-06 | unknown | review fixes: strict isGrepRows, escaped wrapper requotes, no pass cache, quoted assignment prefixes, pinned guidance path
// agent: unknown | xai | 2026-11-06 | unknown | independent review round 2: loose GREP_ROW for context only, rule-file stamp in the rewrite cache, escapeForOuter, callback-based guidance
// agent: unknown | xai | 2026-11-06 | unknown | review follow-up: nested quoted wrapper left bare, versionNote names an unreadable version, guidance fences a backtick path
// agent: unknown | xai | 2026-11-06 | unknown | split into rtk-local.ts + rtk-cli.ts; probe awaited before spawn gates; temp-dir cleanup cannot escape afterToolCall

import type {ModApi} from '@commandcode/harness';
import {accessSync, constants, mkdtempSync, statSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {
	canRefilterCompressed,
	checkFidelity,
	condenseCountRows,
	condenseGrepRows,
	condensePaths,
	extractSpillNotices,
	filterForShape,
	filterNameFor,
	splitSegments,
	stripAnsi,
	removeTree,
} from './rtk-local.ts';
import {
	classifyRewrite,
	guidanceText,
	isSupportedVersion,
	joinForRewrite,
	MIN_SUPPORTED_RTK_MINOR,
	parseRtkVersion,
	pinBinary,
	type RewriteVerdict,
	type RtkVersion,
	shouldRewrite,
	splitRewrite,
	subAgentGuidance,
} from './rtk-cli.ts';
import {
	AGENT_TOOL,
	announceMode,
	filterShell,
	isShellTool,
	NORMAL_MODE,
	pipeCommand,
	readOwnMode,
	resolveBin,
	turnOffSiblings,
	windowsPipeScript,
	withAgentBlock,
	wrapBlock,
	writeOwnMode,
	OFF,
} from './shared.ts';

export const REWRITE_TIMEOUT_MS = 2000;

// Rules: below this the extra process costs more than the filter saves.
export const MIN_FILTER_BYTES = 1200;


const FILTER_TIMEOUT_MS = 5000;

// Rules: grouping is applied by hand because toLocaleString varies with the host locale, so the message would differ per machine.
function grouped(value: number): string {
	return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Rules: an agent with no shell tool cannot follow the block, so it is not sent one. The names are the host's reserved ones and a custom file using them is ignored, so they always resolve to these bundled tool sets (measured on 1.88.2): `explore` is glob/grep/read_file/read_directory and `plan` is read_file alone. `general` and every custom agent may run shell, and an omitted `subagent_type` defaults to `general`, so those still get it.
const NO_SHELL_AGENTS = new Set(['explore', 'plan']);

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

	// Rules: an explicit `--mod-option rtk-bin=…` is never probed, so a typo used to be reported as the binary and the guidance block promised rewrites that could never run. Both sources get one regular-file and executable check here; a directory is not a binary even when it is searchable. Resolution itself stays unverified so a path that appears later still works. This answer gates status, guidance, and every process spawn.
	function binUsable(): boolean {
		const bin = binPath();
		if (!bin) return false;
		try {
			if (!statSync(bin).isFile()) return false;
			accessSync(bin, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	// Rules: the rewrite is judged against the session's rules, so it runs in the session cwd; a deny file above it is found the same way rtk finds it for any other host.
	const cwd = typeof cmd.cwd === 'string' && cmd.cwd ? cmd.cwd : undefined;

	// Rules: rtk checks a deny before it rewrites, so a cached rewrite is also a deferred deny. The cache key carries a stamp of every reachable rule file; a file added or edited mid-session changes the stamp and the command is asked again. A false positive only costs a spawn. The names are the ones rtk 1.1.0 reports for its own pipeline and filters.
	const RULE_FILE_NAMES = ['pipeline.toml', '.rtk/pipeline.toml', '.rtk/filters.toml'];
	const HOME_RULE_FILE_NAMES = ['pipeline.toml', 'filters.toml'];
	function ruleStamp(): string {
		const roots: string[] = [];
		let dir = cwd ?? process.cwd();
		for (;;) {
			roots.push(dir);
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		const home = homedir();
		const config = process.env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
		const parts: string[] = [];
		for (const root of roots) {
			for (const name of RULE_FILE_NAMES) {
				const file = join(root, name);
				try {
					const stat = statSync(file);
					parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
				} catch {
					parts.push(`${file}:none`);
				}
			}
		}
		for (const name of HOME_RULE_FILE_NAMES) {
			const file = join(config, 'rtk', name);
			try {
				const stat = statSync(file);
				parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
			} catch {
				parts.push(`${file}:none`);
			}
		}
		return parts.join('|');
	}

	let version: RtkVersion | null = null;
	let versionProbe: Promise<void> | null = null;
	let isVersionProbed = false;
	// undefined means undecided; a mode change clears it so a re-enable decides again.
	let guidanceDecided: boolean | undefined;
	const supported = () => isSupportedVersion(version);
	const versionNote = () => {
		if (!binUsable()) return 'binary: NOT FOUND';
		if (!version) return isVersionProbed ? `binary: ${binPath()} (version unreadable)` : `binary: ${binPath()}`;
		const label = `${version.major}.${version.minor}.${version.patch}`;
		return supported() ? `binary: ${label}` : `binary: ${label} (too old — need >= 0.${MIN_SUPPORTED_RTK_MINOR}.0)`;
	};
	// Rules: one probe per session. onSessionStart runs fire-and-forget, so the first round would otherwise spawn a second `rtk --version` while the first is still in flight; memoising keeps it to one.
	const versionSettled = () => {
		versionProbe ??= readVersion().finally(() => {
			isVersionProbed = true;
		});
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
	// Rules: the stored mode says what the user asked for, not what the session can do. `compress` prints one line for three mods, so it needs to know that `rtk=on` condenses nothing without a usable, new-enough binary — otherwise that line claims a capability the session does not have. The reason is returned rather than a bare boolean, because "no binary", "too old", and "version unreadable" call for different fixes. A first paint can happen before the probe answers; start it here and say "version pending" rather than claiming the binary works. `version` stays null both before and after an unreadable probe, so the settled flag separates the two.
	cmd.expose('inactiveReason', () => {
		if (!binUsable()) return 'no binary';
		if (!isVersionProbed) {
			void versionSettled();
			return 'version pending';
		}
		if (!version) return 'rtk version unreadable';
		return supported() ? null : `rtk too old, needs >= 0.${MIN_SUPPORTED_RTK_MINOR}.0`;
	});

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
		if (!bin || !binUsable()) return;
		try {
			const {stdout} = await exec({command: bin, args: ['--version']}, REWRITE_TIMEOUT_MS);
			version = parseRtkVersion(stdout);
		} catch {
			version = null;
		}
	}

	// Rules: a rewrite is a pure function of the command line and the resolved binary, and a session repeats the same few commands constantly (`git status`, `git diff`, `npm test` six times in a row is normal). Each `rtk rewrite` measured 30-160 ms here, so a session cache removes most of that cost. The key carries the rule-file stamp: rtk checks a deny before it rewrites, so a rewrite cached before a rule edit would bypass the new deny. A deny or pass is never cached; a pass is re-asked because the next call can add a rule.
	// Rules: bounded so a long session cannot grow it without limit, and keyed on the exact line, so a different argument set is a different entry.
	const rewriteCache = new Map<string, RewriteVerdict>();

	async function rewrite(command: string): Promise<RewriteVerdict> {
		const bin = binPath();
		if (!bin || !supported()) return {kind: 'pass'};
		const cacheKey = `${ruleStamp()}\0${command}`;
		const cached = rewriteCache.get(cacheKey);
		if (cached) return cached;
		try {
			const {stdout, code} = await exec({command: bin, args: ['rewrite', command]}, REWRITE_TIMEOUT_MS);
			const verdict = classifyRewrite(code, stdout, command);
			if (verdict.kind === 'rewrite') {
				if (rewriteCache.size >= 128) rewriteCache.clear();
				rewriteCache.set(cacheKey, verdict);
			}
			return verdict;
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
			// Rules: cleanup is best effort. A throw here would replace the return value and escape `afterToolCall`, turning a condensed result into a failed hook on a locked Windows temp dir.
			if (dir) removeTree(dir);
		}
	}

	// Rules: the local condensers are the only part that need no process, so they are split out. Every caller runs them first, whatever the binary state — that is what makes a grep or glob result still shrink on a machine with no rtk installed, and below the byte floor where a spawn would not be worth it.
	// Rules: no filter argument. The two local passes are shape-selected internally (`condenseGrepRows` refuses anything that is not a match row, `condensePaths` anything that is not a bare path), so the tool's filter choice was already unused here — it is passed only to `condense()`, which is where rtk is actually asked to filter.
	function condenseLocally(toolName: string, text: string): string | null {
		const {head, body, tail} = splitSegments(toolName, text);
		const plainBody = stripAnsi(body);
		const {body: filterable, notices} = extractSpillNotices(plainBody);
		// Rules: content-mode grep rows are condensed locally, with no process. Measured against rtk 1.1.0 on the same bodies, the local pass wins every common shape (20 files x 5 hits 6,850 -> 1,681 vs rtk's 6,591; 30 files x 1 hit 1,671 -> 701 vs rtk's unchanged 1,671; count mode 17,140 -> 2,421 vs 14,331) and it never drops a file, where rtk's find filter named only 10 of 20. It also removes the spawn: grep results cost 0 ms instead of rtk's measured 12-15 ms. The fidelity check still runs, so a cap that would drop every negation is refused.
		const local = condenseGrepRows(filterable);
		if (local !== null && checkFidelity(filterable, local, false).ok) {
			const next = `${head}${notices ? `${local}\n${notices}` : local}${tail}`;
			if (next.length < text.length) return next;
		}
		// Rules: the same reasoning applies to a path list. rtk's find filter loses whole directories on a wide tree (measured 19 of 60 named), and the local pass keeps every one for a few more percent. It is tried only when the body is one clean path per line, so a shell listing still goes to rtk.
		const localPaths = condensePaths(filterable);
		if (localPaths !== null) {
			const next = `${head}${notices ? `${localPaths}\n${notices}` : localPaths}${tail}`;
			if (next.length < text.length) return next;
		}
		// Rules: the host's count mode is its own shape (`path:count`) and gets its own layout, because both other condensers refuse it: the row parser needs a third field, and the path tree would print the count where a line number goes. rtk leaves this shape byte-identical (measured 634 -> 634), so without this pass it reaches the model at full size.
		const localCounts = condenseCountRows(filterable);
		if (localCounts !== null) {
			const next = `${head}${notices ? `${localCounts}\n${notices}` : localCounts}${tail}`;
			if (next.length < text.length) return next;
		}
		return null;
	}

	// Rules: only the body is condensed; the host's own header and trailer are re-attached verbatim, so an exit status or a truncation notice cannot be folded away.
	// Rules: colour is removed from the body whether or not the rtk pass below succeeds. rtk keeps escapes, so a result it declines would otherwise arrive at full size and still carry 33% of bytes that mean nothing — the strip alone is the win on those, and it is why the byte floor is checked after it, not before.
	// Rules: the spill pointer rides in the MIDDLE of the result, so it is lifted out before filtering and put back after. The host writes it where the elision happened; a result that lost it leaves the model with no way to reach the rest of the output, which was measured: a 2,951-byte pytest result came back at 296 bytes with both pointer lines gone.
	// Rules: the byte floor gates the rtk SPAWN, not the local pass. The local condensers cost no process, so they run below it — an 870-byte body of 20 files x 3 hits still went 870 -> 360, and a 790-byte path list 790 -> 385. Skipping those would leave the cheapest win unused.
	// Rules: the local pass is NOT repeated here. Every caller runs `condenseLocally` first and has already returned a non-null answer — that is what makes the free passes run below the byte floor and without a binary — so re-running it here doubled the work on every result that reached the rtk spawn (measured 0.6-1.4 ms per grep/glob result).
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
				await versionSettled();
				return {message: `RTK: ${mode} (${versionNote()})`};
			}
			if (arg !== 'on' && arg !== 'off') return {message: 'Usage: /rtk [on|off|gain|status]'};
			setMode(arg);
			if (arg === 'on') {
				await versionSettled();
				if (!binUsable()) return {message: 'RTK on, but the rtk binary was not found. Install it, then /reload.'};
				if (!supported()) return {message: `RTK on, but ${versionNote()}. Upgrade rtk — rewrites fall back to raw until then.`};
			}
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
			// Rules: the default is off, so an off session must not spawn a version probe it never uses. The probe runs when the mode is on, and `/rtk status` and `/rtk on` ask for it on demand.
			if (mode !== OFF) void versionSettled();
		},

		// Rules: the block must be byte-stable across rounds or the provider's prompt-prefix cache misses every turn, so the decision is taken once and reused for the session. A mode change is the one legitimate reason for the block to change, and it is a durable input the caller actually changed.
		// Rules: the version probe is awaited before the decision. `onSessionStart` starts it fire-and-forget, so the first round used to decide on `null`, and `isSupportedVersion(null)` grants the benefit of the doubt — measured: an rtk 0.0.1 session was told to use rtk for rewrites that can never run, and the wrong answer was then cached for the whole session. Awaiting keeps the bytes stable and makes them correct: the promise is memoised, so only the first call waits at all.
		appendSystemPrompt: async () => {
			const bin = binPath();
			if (mode === OFF || !bin) return undefined;
			await versionSettled();
			// Rules: the mode can change while the probe runs, in which case there is nothing left to inject.
			if (mode === OFF) return undefined;
			guidanceDecided ??= binUsable() && supported();
			return guidanceDecided ? wrapBlock('rtk', guidanceText(bin)) : undefined;
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
			if (mode === OFF) return undefined;
			// Rules: the child gets no rewrite hook, so the only way its calls are condensed is the child doing it itself. The block names the resolved absolute path, and is added only with a usable, new-enough binary — otherwise it would instruct a session to run something that cannot.
			if (toolName === AGENT_TOOL) {
				const agent = typeof input.subagent_type === 'string' ? input.subagent_type.trim().toLowerCase() : '';
				if (NO_SHELL_AGENTS.has(agent)) return undefined;
				if (!bin || !binUsable()) return undefined;
				await versionSettled();
				if (!supported()) return undefined;
				const next = withAgentBlock(input, 'rtk', subAgentGuidance(bin));
				return next ? {input: next} : undefined;
			}
			// Rules: the probe is awaited before `supported()`, matching `appendSystemPrompt` and the agent branch above. `isSupportedVersion(null)` grants the benefit of the doubt, which is right before the probe answers and wrong as its answer — an old binary must never be asked to rewrite.
			if (!isShellTool(toolName) || !bin || !binUsable()) return undefined;
			await versionSettled();
			if (!supported()) return undefined;
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
				if (cmd.getFlag('rtk-filter') === false) return stripped;
				// Rules: the local pass needs no binary and no byte floor, so it is tried before either guard. A session without rtk still gets its grep and glob results grouped, and a body under 1,200 bytes still shrinks. The guards below only gate the spawn.
				const local = condenseLocally(toolName, text);
				if (local) return {content: [{type: 'text', text: local}]};
				// Rules: the probe is awaited before the spawn gate, so the answer is the version, not the benefit of the doubt.
				if (text.length < MIN_FILTER_BYTES || !binUsable()) return stripped;
				await versionSettled();
				if (!supported()) return stripped;
				const filtered = await condense(toolName, filter, text);
				return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
			}

			// Shell output with no rewrite is still auto-detected: `npm test` output can be cargo-shaped.
			if (!isShellTool(toolName)) return undefined;
			if (cmd.getFlag('rtk-shell') === false) return stripped;
			// Rules: a rewritten call is skipped because rtk already filtered it — except when rtk declined and left its faithful baseline, which `canRefilterCompressed` recognises. Anything carrying a recovery hint stays skipped, so a recall hash is never dropped.
			// Rules: the shape test reads the plain text. `path:line:text` rows with an escape before the column still match the row pattern, but a styled `+3 more files` marker would not — testing the raw bytes could let a marked result through the second pass and drop its recall hash.
			if (alreadyRewritten && !canRefilterCompressed(plain)) {
				// Rules: rtk filtered the body but keeps every colour escape, so the strip still applies here. It deletes only escapes, which carry no information, so the envelope and every fact survive.
				return stripped;
			}
			// Rules: a rewritten call that rtk declined is a match list or a path list by construction, which is exactly what the local pass handles, and it needs no second process. It runs before the binary guard for the same reason as on the grep path.
			const local = condenseLocally(toolName, text);
			if (local) return {content: [{type: 'text', text: local}]};
			if (!binUsable()) return stripped;
			await versionSettled();
			if (!supported()) return stripped;
			if (text.length < MIN_FILTER_BYTES) return stripped;
			const filtered = await condense(toolName, null, text);
			return filtered ? {content: [{type: 'text', text: filtered}]} : undefined;
		},
	});
}

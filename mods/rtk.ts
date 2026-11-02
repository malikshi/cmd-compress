// rtk — condensed shell output: rewrites shell_command through `rtk rewrite` and filters grep/glob results.
// exports: default (ModFactory), REWRITE_TIMEOUT_MS, MIN_FILTER_BYTES, shouldRewrite, filterNameFor
// used_by: package.json (commandcode.mods), mods/compress.ts, test/rtk.test.ts
// related: mods/shared.ts
// rules: fail open on every path — a missing binary, a timeout, or exit 1/2 leaves the original command untouched.
// agent: 2026-11-02 ported from rtk-ai/rtk hooks/pi/rtk.ts and tersio extensions/rtk

import type {ModApi} from '@commandcode/harness';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readOwnMode, resolveBin, wrapBlock, writeOwnMode, OFF} from './shared.ts';

export const REWRITE_TIMEOUT_MS = 2000;

// Rules: below this the extra process costs more than the filter saves.
export const MIN_FILTER_BYTES = 1200;

const FILTER_TIMEOUT_MS = 5000;

const FILTER_BY_TOOL: Record<string, string> = {grep: 'grep', glob: 'find'};

export function filterNameFor(toolName: string): string | undefined {
	return FILTER_BY_TOOL[toolName];
}

const GUIDANCE = `RTK is active: shell output is condensed before it reaches you. Every signal survives — the failing test name, the assertion, the file and line. Treat a condensed result as complete and re-run it unfiltered only when the result is empty when output was expected, contradicts its exit code, or is garbled.

Call rtk directly for what the automatic rewrite cannot express: \`rtk read <file> --level aggressive\` for an overview, \`rtk smart <file>\` for two lines, \`rtk err <cmd>\` for errors only, \`rtk log <file>\` to dedupe, \`rtk json <file> --keys-only\` for shape, \`rtk deps\`, \`rtk diff\`, \`rtk env\`, \`rtk test <cmd>\`, and \`rtk find -name '*.ts'\`. Do not type \`rtk\` in front of a command already rewritten for you. \`rtk gain\` reports what it saved; \`RTK_DISABLED=1 <cmd>\` skips it for one command.`;

// Rules: a command that is already rtk-prefixed, empty, or a shell function definition is left alone so rewrites cannot compound.
export function shouldRewrite(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return false;
	if (/^rtk\s/.test(trimmed)) return false;
	if (/^RTK_DISABLED=/.test(trimmed)) return false;
	return true;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('rtk', {type: 'string', default: '', description: 'Start mode: on|off (default: off)'});
	cmd.addFlag('rtk-filter', {type: 'boolean', default: true, description: 'Also condense grep/glob tool output'});

	let mode = readOwnMode(cmd.store);

	const bin = resolveBin('rtk');

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

	cmd.addCommand({
		name: 'rtk',
		description: 'Toggle RTK condensed shell output for this session',
		argumentHint: '[on|off|status]',
		handler: ({args}) => {
			const arg = args.trim().toLowerCase();
			if (!arg || arg === 'status') {
				const where = bin ? `binary: ${bin}` : 'binary: NOT FOUND — install rtk, then /reload';
				return {message: `RTK: ${mode} (${where})`};
			}
			if (arg !== 'on' && arg !== 'off') return {message: 'Usage: /rtk [on|off|status]'};
			setMode(arg);
			if (arg === 'on' && !bin) return {message: 'RTK on, but the rtk binary was not found. Install it, then /reload.'};
			return {message: `RTK ${arg}.`};
		},
	});

	// Rules: rewrite only when a binary exists and the mode is on; every failure returns undefined (pass through).
	async function rewrite(command: string): Promise<string | null> {
		if (!bin) return null;
		try {
			const {stdout, code} = await cmd.exec({
				command: bin,
				args: ['rewrite', command],
				timeout: REWRITE_TIMEOUT_MS,
			});
			if (code !== 0 && code !== 3) return null;
			const rewritten = stdout.trim();
			return rewritten && rewritten !== command ? rewritten : null;
		} catch {
			return null;
		}
	}

	// Rules: `rtk pipe` reads stdin and exec has no stdin, so the text goes to a temp file and is redirected in.
	// Rules: never pass tool output through a heredoc — a line equal to the delimiter would run as shell.
	async function filterThroughRtk(filter: string, text: string): Promise<string | null> {
		if (!bin || process.platform === 'win32') return null;
		let dir: string | undefined;
		try {
			dir = mkdtempSync(join(tmpdir(), 'cmd-compress-'));
			const file = join(dir, 'in.txt');
			writeFileSync(file, text, 'utf8');
			const {stdout, code} = await cmd.exec({
				command: '/bin/sh',
				args: ['-c', `"${bin}" pipe -f ${filter} < "${file}"`],
				timeout: FILTER_TIMEOUT_MS,
			});
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

	function textOf(result: unknown): string | null {
		if (!Array.isArray(result) || result.length === 0) return null;
		const parts = result as Array<{type?: string; text?: string}>;
		if (parts.some(part => part?.type !== 'text')) return null;
		return parts.map(part => part.text ?? '').join('\n');
	}

	cmd.hooks({
		// Rules: a flag is a per-session override, applied when the host binds — getFlag answers the default at factory time.
		onSessionStart: () => {
			const flag = String(cmd.getFlag('rtk') ?? '').trim().toLowerCase();
			if (flag === 'on' || flag === 'off') mode = flag;
		},

		appendSystemPrompt: () => (mode === OFF || !bin ? undefined : wrapBlock('rtk', GUIDANCE)),

		beforeToolCall: async ({toolName, input}) => {
			if (mode === OFF || toolName !== 'shell_command') return undefined;
			const command = typeof input.command === 'string' ? input.command : '';
			if (!shouldRewrite(command)) return undefined;
			const rewritten = await rewrite(command);
			return rewritten ? {input: {...input, command: rewritten}} : undefined;
		},

		afterToolCall: async ({toolName, result, isError}) => {
			if (mode === OFF || isError) return undefined;
			if (cmd.getFlag('rtk-filter') === false) return undefined;
			const filter = filterNameFor(toolName);
			if (!filter) return undefined;
			const text = textOf(result);
			if (text === null || text.length < MIN_FILTER_BYTES) return undefined;
			const filtered = await filterThroughRtk(filter, text);
			if (!filtered) return undefined;
			return {content: [{type: 'text', text: filtered}]};
		},
	});
}

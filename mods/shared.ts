// shared — mode lookup, prompt-block helpers, and binary/path utilities for the four mods.
// exports: MODES, OFF, DEFAULT_MODE, readOwnMode, writeOwnMode, wrapBlock, stripBlock, promptHas, resolveBin, shortPaths, turnOffSiblings
// used_by: mods/*.ts, test/*.test.ts
// related: rules/caveman.ts, rules/ponytail.ts
// rules: cmd.store is namespaced per mod, so a mod persists ONLY its own key; a sibling's mode is read through cmd.use.
// rules: prompt text must be byte-stable per mode so the provider prefix cache survives across rounds.
// agent: 2026-11-02 initial — per-mod store key after learning each mod gets its own file
// agent: 2026-11-03 turnOffSiblings — "normal mode" must end every mode, and transformInput short-circuits on handled

import {accessSync, constants, existsSync} from 'node:fs';
import {delimiter, join} from 'node:path';
import {homedir} from 'node:os';

export const MODES = ['caveman', 'ponytail', 'rtk'] as const;
export type ModeName = (typeof MODES)[number];

export const OFF = 'off';

// Rules: both upstream references use this one phrase to mean "stop every mode", so it is the shared trigger for turning siblings off, not a caveman-only alias.
export const NORMAL_MODE = 'normal mode';

// Rules: a fresh install starts with every mode off — compression is opt-in, so nothing changes silently.
export const DEFAULT_MODE = OFF;

// The one key each mod owns in its own store file.
const MODE_KEY = 'mode';

interface StoreLike {
	get(key: string): unknown;
	set(key: string, value: unknown): Promise<void>;
}

// Rules: a malformed value degrades to the default — a corrupt store must not break a session, and it must not silently ENABLE compression either. An unrecognised level would otherwise reach the rules text, which falls back to the default block: the mode reads "on" while the status line shows garbage.
export function readOwnMode(
	store: StoreLike,
	fallback: string = DEFAULT_MODE,
	isValid: (value: string) => boolean = () => true,
): string {
	const raw = store.get(MODE_KEY);
	return typeof raw === 'string' && raw && isValid(raw) ? raw : fallback;
}

// Rules: writes are fire-and-forget but serialised per process, so two setters in one tick keep the last value.
let writeChain: Promise<void> = Promise.resolve();

export function writeOwnMode(store: StoreLike, value: string): void {
	writeChain = writeChain
		.then(() => store.set(MODE_KEY, value))
		.catch(() => {
			// a failed persist must not reject the chain and skip later writes
		});
}

type Setter = (value: unknown) => boolean;

// Rules: `normal mode` is one phrase for every mode, but the host's transformInput chain stops at the first `handled`. So the mod that sees it turns its SIBLINGS off through their exposed setMode, and only then answers handled — otherwise the phrase would end one mode and leave the rest running.
export function turnOffSiblings(use: (mod: string, name: string) => unknown, self: ModeName): string[] {
	const off: string[] = [];
	for (const name of MODES) {
		if (name === self) continue;
		const setMode = use(name, 'setMode') as Setter | undefined;
		if (setMode) {
			setMode(OFF);
			off.push(name);
		}
	}
	return off;
}

/* ---------------------------------------------------------------- prompt text */
export function promptHas(prompt: string, marker: string): boolean {
	return prompt.includes(marker);
}

export function wrapBlock(tag: string, body: string): string {
	return `<${tag}>\n${body.trim()}\n</${tag}>`;
}

// Rules: removes every previously injected <tag> block so a level change cannot leave two rulesets.
export function stripBlock(prompt: string, tag: string): string {
	const pattern = new RegExp(`\\n*<${tag}>[\\s\\S]*?</${tag}>\\n*`, 'g');
	return prompt
		.replace(pattern, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd();
}

/* ---------------------------------------------------------------- binaries */

// Rules: the platform's own command shell, since `rtk pipe` reads stdin and the redirect has to be interpreted. `wrap` marks the platform whose shell re-parses its own /c line and therefore cannot be handed nested quoting.
// Rules: the platform and ComSpec are parameters, not reads of the ambient process, so both branches are reachable from a test on either OS — otherwise the win32 path is code no run ever executes.
export function filterShell(
	platform: string = process.platform,
	comspec: string | undefined = process.env.ComSpec,
): {command: string; args: string[]; wrap: boolean} {
	if (platform === 'win32') {
		return {command: comspec || 'cmd.exe', args: ['/d', '/s', '/c'], wrap: true};
	}
	return {command: '/bin/sh', args: ['-c'], wrap: false};
}

// Rules: cmd.exe re-parses its /c line, and nested quotes do not survive that second pass — measured on windows-latest CI, where `""…\rtk.cmd" pipe -f grep < "…\in.txt""` was rejected with "is not recognized as an internal or external command". A batch file removes the second parse: the script holds the real line once, and cmd.exe is asked only to run one path.
export function windowsPipeScript(bin: string, filter: string | null, file: string): string {
	const flags = filter ? `-f ${filter} ` : '';
	return `@echo off\r\n"${bin}" pipe ${flags}< "${file}"\r\n`;
}

// Rules: `rtk pipe` takes its input on stdin and the host exec has no stdin, so the text is redirected in from a file; this is the one place the shell line is built. When the shell wraps (cmd.exe) the caller passes the batch file it wrote, and only that path reaches the command line.
export function pipeCommand(
	bin: string,
	filter: string | null,
	file: string,
	shell: {command: string; args: string[]; wrap: boolean},
	scriptPath?: string,
): {command: string; args: string[]} {
	const flags = filter ? `-f ${filter} ` : '';
	const line = `"${bin}" pipe ${flags}< "${file}"`;
	if (shell.wrap) {
		return {command: shell.command, args: [...shell.args, scriptPath ?? line]};
	}
	return {command: shell.command, args: [...shell.args, line]};
}

// Rules: rtk ships to ~/.bun/bin and is often off PATH for GUI hosts, so probe PATH then the managed dir.
export function resolveBin(
	name: string,
	extraDirs: readonly string[] = [join(homedir(), '.bun', 'bin')],
): string | null {
	const exe = process.platform === 'win32' ? `${name}.exe` : name;
	const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs];
	for (const dir of dirs) {
		const candidate = join(dir, exe);
		try {
			if (existsSync(candidate)) {
				accessSync(candidate, constants.X_OK);
				return candidate;
			}
		} catch {
			// not executable: keep probing
		}
	}
	return null;
}

/* ---------------------------------------------------------------- paths */

// Rules: a shortened path must stay identifiable — drop only the workspace prefix, keep the tail.
export function shortPaths(text: string, cwd: string): string {
	if (!cwd || cwd === '/') return text;
	const prefix = cwd.endsWith('/') ? cwd.slice(0, -1) : cwd;
	const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return text.replace(new RegExp(`(^|[\\s"'\`(])${escaped}/`, 'g'), '$1');
}

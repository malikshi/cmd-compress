// harness.ts — a fake ModApi for exercising the mods without a TUI.
// exports: createFakeCmd, createEventBus, runHandler
// used_by: test/mods.behaviour.test.ts
// related: mods/caveman.ts, mods/ponytail.ts, mods/rtk.ts, mods/compress.ts
// rules: the fake mirrors only the surface these mods touch (store/expose/use/hooks/commands/flags/exec/ui), so a mod reaching further fails loudly.
// agent: 2026-11-02 initial

import type {ModEventBus as _ModEventBus} from '@commandcode/harness';

export interface FakeCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	handler: (ctx: {args: string}) => unknown;
}

// Rules: the mods announce mode changes on the shared bus so `compress` can repaint its footer, so the fake must provide one too — a fake without it silently exercises the degraded path instead of production's.
export function createEventBus(): _ModEventBus {
	const channels = new Map<string, Set<(data?: unknown) => void>>();
	return {
		emit: (channel: string, data?: unknown) => {
			for (const handler of channels.get(channel) ?? []) {
				try {
					handler(data);
				} catch {
					// the host isolates a throwing subscriber; so does the fake
				}
			}
		},
		on: (channel: string, handler: (data?: unknown) => void) => {
			const set = channels.get(channel) ?? new Set();
			set.add(handler);
			channels.set(channel, set);
			return {dispose: () => set.delete(handler)};
		},
	};
}

export interface FakeHooks {
	appendSystemPrompt?: () => string | undefined;
	transformInput?: (arg: {text: string}) => unknown;
	beforeToolCall?: (arg: {toolCallId?: string; toolName: string; input: Record<string, unknown>}) => Promise<unknown>;
	afterToolCall?: (arg: {toolCallId?: string; toolName: string; result: unknown; isError: boolean}) => Promise<unknown>;
	onSessionStart?: () => void;
	onRunEnd?: () => void;
}

export interface FakeExecRequest {
	command: string;
	args?: string[];
	cwd?: string;
	signal?: AbortSignal;
}

export function createFakeCmd(options: {flags?: Record<string, unknown>; exec?: (request: FakeExecRequest) => Promise<{stdout: string; stderr: string; code: number}>} = {}) {
	const stores = new Map<string, Map<string, unknown>>();
	const exposed = new Map<string, Map<string, unknown>>();
	const commands = new Map<string, FakeCommand>();
	const hooks: FakeHooks[] = [];
	const statuses: string[] = [];
	const flags = {...options.flags};

	function createStore(name: string) {
		const data = stores.get(name) ?? new Map<string, unknown>();
		stores.set(name, data);
		return {
			data,
			get: (key: string) => data.get(key),
			set: async (key: string, value: unknown) => {
				data.set(key, value);
			},
		};
	}

	const cmd = {
		name: 'fake',
		cwd: '/repo',
		addFlag: (name: string, spec: {default?: unknown}) => {
			if (!(name in flags)) flags[name] = spec.default;
		},
		getFlag: (name: string) => flags[name],
		getCommands: () => [...commands.values()].map(command => ({name: command.name, description: command.description})),
		expose: (name: string, fn: unknown) => {
			const mod = exposed.get(cmd.name) ?? new Map<string, unknown>();
			mod.set(name, fn);
			exposed.set(cmd.name, mod);
		},
		use: (mod: string, name: string) => exposed.get(mod)?.get(name),
		addCommand: (command: FakeCommand) => {
			commands.set(command.name, command);
		},
		hooks: (next: FakeHooks) => {
			hooks.push(next);
		},
		store: createStore('fake'),
		exec: options.exec ?? (async () => ({stdout: '', stderr: '', code: 0})),
		ui: {
			capabilities: {status: true},
			setStatus: (text: string | null) => {
				if (text !== null) statuses.push(text);
			},
			notify: () => undefined,
		},
		on: () => undefined,
		events: createEventBus(),
		model: {},
	};

	return {
		cmd,
		stores,
		exposed,
		commands,
		hooks,
		statuses,
		useStore(name: string) {
			return createStore(name);
		},
		bindStore(name: string) {
			const store = createStore(name);
			cmd.name = name;
			cmd.store = store as never;
			return store;
		},
	};
}

export function runHandler(commands: Map<string, FakeCommand>, name: string, args = ''): unknown {
	const command = commands.get(name);
	if (!command) throw new Error(`no command ${name}`);
	return command.handler({args});
}

// Rules: every mod registers exactly one hooks object, so this is the single place `hooks[0]` is allowed to be non-null; a typed accessor keeps `noUncheckedIndexedAccess` honest without a cast per call site.
export function firstHook(fake: {hooks: FakeHooks[]}): FakeHooks {
	const [hook] = fake.hooks;
	if (!hook) throw new Error('the mod registered no hooks');
	return hook;
}

// Rules: an afterToolCall result replaces content with one text block; asserting that shape here keeps `noUncheckedIndexedAccess` honest without a cast at each call site.
export function resultText(result: unknown): string {
	const content = (result as {content?: Array<{text?: string}>} | undefined)?.content;
	const text = content?.[0]?.text;
	if (typeof text !== 'string') throw new Error('the hook returned no content text');
	return text;
}

export function messageOf(result: unknown): string {
	const typed = result as {message?: string} | undefined;
	return typed?.message ?? '';
}

// harness.d.ts — the slice of the Command Code mod API these mods compile against.
//
// exports: (module '@commandcode/harness') ModApi, ModHooks, ModCommand, ModFlag, ModUi, ModStoreApi, ModSessionControls
// used_by: mods/*.ts, bench/lib/control.ts, test/harness.ts [cascade]
// related: tsconfig.json, https://commandcode.ai/docs/mods
// rules: mirrors only the surface a mod may call; the field list and semantics are taken verbatim from the bundled mod-builder reference (reference/api.md, reference/hooks-and-events.md), because Command Code ships no type declarations of its own.
// rules: a hook's return type is the contract the host enforces — an unknown field is a silently ignored no-op at runtime, so it must be a type error here instead.
// agent: 2026-11-03 initial — typed the surface the four mods actually use, so `tsc --noEmit` can catch a runtime-silent mistake.

declare module '@commandcode/harness' {
	export type ModFactory = (cmd: ModApi) => void | Promise<void>;

	export interface Disposable {
		dispose(): void;
	}

	/* ------------------------------------------------------------ data */

	export interface AgentUsage {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cacheReadTokens?: number;
		readonly cacheWriteTokens?: number;
	}

	export interface ModContext {
		emit(event: {type: string; [key: string]: unknown}): void;
		signal?: AbortSignal;
		cwd: string;
	}

	/* ------------------------------------------------------------ hooks */

	export interface ToolCallHookArgs {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input: Record<string, unknown>;
	}

	export interface BeforeToolCallResult {
		block?: boolean;
		additionalContext?: string;
		input?: Record<string, unknown>;
		result?: unknown;
		terminate?: boolean;
	}

	export interface AfterToolCallArgs {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input: Record<string, unknown>;
		readonly result: unknown;
		readonly isError: boolean;
	}

	export interface AfterToolCallResult {
		content?: unknown;
		additionalContext?: string;
		isError?: boolean;
		terminate?: boolean;
		modState?: Record<string, unknown>;
	}

	export type TransformInputResult =
		| {action: 'continue'}
		| {action: 'transform'; text: string}
		| {action: 'handled'; message?: string};

	export interface ModHooks {
		appendSystemPrompt?: () => string | undefined | Promise<string | undefined>;
		transformInput?: (arg: {text: string}) => TransformInputResult | undefined;
		beforeToolCall?: (arg: ToolCallHookArgs) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
		afterToolCall?: (arg: AfterToolCallArgs) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
		onSessionStart?: (arg: {source: 'startup' | 'resume' | 'reload'}) => void;
		onSessionEnd?: (arg: {reason: 'shutdown' | 'replaced' | 'reload'}) => void;
		onRunEnd?: () => void;
	}

	/* ------------------------------------------------------------ registrations */

	export interface ModFlag {
		type: 'boolean' | 'string';
		default?: boolean | string;
		description?: string;
	}

	export interface ModCommand {
		name: string;
		description?: string;
		argumentHint?: string;
		handler: (ctx: {args: string}) => {message?: string; prompt?: string} | undefined | Promise<{message?: string; prompt?: string} | undefined>;
	}

	/* ------------------------------------------------------------ ui */

	export interface ModUi {
		readonly capabilities: {readonly status: boolean; readonly surface: boolean};
		setStatus: (text: string | null) => Disposable;
		notify: (message: string, level?: 'info' | 'warning' | 'error') => void;
	}

	/* ------------------------------------------------------------ store */

	export interface ModStoreApi {
		get(key: string): unknown;
		set(key: string, value: unknown): Promise<void>;
		delete(key: string): Promise<void>;
	}

	/* ------------------------------------------------------------ events */

	// Rules: the host's cross-mod bus. `emit(channel, data?)` / `on(channel, handler)`; a handler throw is swallowed by the host, so it can never break a sibling.
	export interface ModEventBus {
		emit(channel: string, data?: unknown): void;
		on(channel: string, handler: (data?: unknown) => void): Disposable;
	}

	/* ------------------------------------------------------------ api */

	export interface ExecRequest {
		command: string;
		args?: string[];
		cwd?: string;
		signal?: AbortSignal;
	}

	export interface ExecResult {
		stdout: string;
		stderr: string;
		code: number;
	}

	export interface ModApi {
		readonly name: string;
		readonly cwd: string;
		readonly store: ModStoreApi;
		readonly ui: ModUi;
		readonly events: ModEventBus;
		addFlag(name: string, spec: ModFlag): Disposable;
		getFlag(name: string): boolean | string | undefined;
		addCommand(command: ModCommand): Disposable;
		hooks(hooks: ModHooks): Disposable;
		expose(name: string, fn: (...args: never[]) => unknown): Disposable;
		use(mod: string, name: string): ((...args: never[]) => unknown) | undefined;
		exec(request: ExecRequest): Promise<ExecResult>;
		on(event: string, handler: () => void): Disposable;
	}
}

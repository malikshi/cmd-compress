// bench/lib/prompts.ts — the fixed prompts and their lexical quality gate.
// exports: PROSE_PROMPTS, PROSE_OPEN, CODE_PROMPTS, checkProse, checkCode, PROMPT_BUDGET
// used_by: bench/prompt.ts, test/bench.test.ts
// related: docs/BENCHMARK.md
// rules: prompts are fixed and versioned here so two people measure the same thing.
// rules: the keyword gate is lexical substring matching, stated as such — it is a floor, not a judge.
// agent: 2026-11-02 initial, prompts taken from tersio docs/BENCHMARK_GUIDE.md §7

export interface ProsePrompt {
	readonly id: string;
	readonly text: string;
	readonly groups: readonly (readonly string[])[];
}

// Rules: every group must match at least one term; a group is an OR, the list is an AND.
// Rules: a code prompt must be self-contained and forbid tool use, or the model explores the repo and the run ends at max-turns.
// Rules: this surface measures reply size, so a deviation from tersio's prompt text is required and is stated in docs/BENCHMARK.md.
export interface CodePrompt {
	readonly id: string;
	readonly text: string;
	readonly required: readonly string[];
}

export const PROSE_PROMPTS: readonly ProsePrompt[] = [
	{
		id: 'P1',
		text: 'Explain in three sentences how a database connection pool improves throughput under load.',
		groups: [['reus'], ['connection'], ['overhead', 'cost'], ['concurren', 'wait']],
	},
	{
		id: 'P2',
		text: 'Explain in three sentences why an index speeds up a database query.',
		groups: [['index'], ['quer'], ['scan', 'search', 'tree', 'lookup'], ['rows', 'table', 'data', 'disk']],
	},
	{
		id: 'P3',
		text: 'Explain in three sentences how HTTP caching reduces server load.',
		groups: [['cach'], ['server', 'origin', 'backend'], ['load', 'bandwidth', 'request', 'traffic']],
	},
];

// Rules: a length-pinned prompt ("three sentences") fixes the reply size, so it cannot show whether a brevity mode saves
// anything. The open set is the fair test of caveman's claim: the answer length is the model's choice.
export const PROSE_OPEN: readonly ProsePrompt[] = [
	{
		id: 'O1',
		text: 'Explain how database connection pooling works and why it matters under load.',
		groups: [
			['pool', '池'],
			['connection', '連線', '连接'],
			['reus', 'overhead', 'cost', '複用', '复用', '耗'],
			['load', 'concurren', 'wait', '負載', '并发', '並發', '排隊'],
		],
	},
	{
		id: 'O2',
		text: 'Explain what a database index does and when it helps.',
		groups: [
			['index', '索引'],
			['quer', 'scan', 'lookup', 'tree', '查詢', '扫描'],
			['row', 'table', 'data', 'disk', '行', '表', '資料', '磁盘'],
		],
	},
	{
		id: 'O3',
		text: 'Explain how HTTP caching works and what it saves.',
		groups: [
			['cach', '快取', '缓存'],
			['server', 'origin', 'backend', 'client', '伺服', '服务器', '後端', '后端'],
			['load', 'bandwidth', 'request', 'traffic', 'latenc', '請求', '请求', '頻寬', '带宽', '延遲'],
		],
	},
];

export const CODE_PROMPTS: readonly CodePrompt[] = [
	{
		id: 'C1',
		text: 'Write a TypeScript function `chunk<T>(items: T[], size: number): T[][]` that splits an array into fixed-size chunks, and `chunkLazy` that yields chunks from an iterable without materializing the whole array. Reply with the code only; do not read, create, or edit any file.',
		required: ['chunk', 'chunkLazy'],
	},
	{
		id: 'C2',
		text: 'Write a TypeScript `debounce` and a `throttle`, both with the signature `(fn: (...args: T) => void, ms: number)`. Reply with the code only; do not read, create, or edit any file.',
		required: ['debounce', 'throttle'],
	},
	{
		id: 'C3',
		text: 'Write a TypeScript `groupBy<T, K extends PropertyKey>(items: T[], key: (item: T) => K): Record<K, T[]>` and `countBy` with the same inputs returning `Record<K, number>`. Reply with the code only; do not read, create, or edit any file.',
		required: ['groupBy', 'countBy'],
	},
];

// Rules: never pass any group, so a control ("Answer concisely.") is comparable and a miss is visible.
export function checkProse(reply: string, prompt: ProsePrompt): boolean {
	const text = reply.toLowerCase();
	return prompt.groups.every(group => group.some(term => text.includes(term)));
}

export function checkCode(reply: string, prompt: CodePrompt): boolean {
	return prompt.required.every(name => reply.includes(name));
}

// Rules: a code prompt needs a follow-up turn to emit the file, and exit 8 (max-turns) is a failed run, not a sample.
// Rules: the budget bounds cost; it is not itself a result.
export const PROMPT_BUDGET = {maxTurns: 6, timeoutMs: 240_000} as const;

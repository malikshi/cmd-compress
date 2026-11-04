// bench/lib/stats.ts — medians, percentiles, and byte/token helpers shared by both benches.
// exports: median, percentile, reduction, estimateTokens, formatBytes, formatPct, table
// used_by: bench/output.ts, bench/prompt.ts
// related: docs/BENCHMARK.md
// rules: an estimate is always labelled as one — only live session usage is reported as tokens.
// agent: unknown | unknown | 2026-11-02 | unknown | initial

export function median(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const lower = sorted[mid - 1] ?? 0;
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 0 ? (lower + upper) / 2 : upper;
}

export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[index] ?? 0;
}

// Rules: a shrink is positive; a filter that grew its input reports a negative reduction, never a clamped zero.
export function reduction(inputBytes: number, outputBytes: number): number {
	if (inputBytes === 0) return 0;
	return 1 - outputBytes / inputBytes;
}

// Rules: chars/4 is an estimate, so it is only used to compare surfaces with each other, never as a bill figure.
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function formatBytes(bytes: number): string {
	return bytes.toLocaleString('en-US');
}

export function formatPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

// Rules: columns are padded to the widest cell so a pasted table stays readable in a terminal and in markdown.
export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
	);
	const line = (cells: readonly string[]) =>
		cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
	const divider = widths.map(width => '-'.repeat(width)).join('  ');
	return [line(headers), divider, ...rows.map(line)].join('\n');
}

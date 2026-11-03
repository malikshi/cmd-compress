// bench/lib/fixtures.ts — deterministic command output, so bytes-in reproduce on any machine.
// exports: makeGrepClustered, makeGrepScattered, makeFindOutput, REWRITE_COMMANDS
// used_by: bench/output.ts, test/bench.test.ts
// related: bench/lib/stats.ts
// rules: output is generated from a fixed seed and sorted, so two machines measure identical bytes.
// rules: grep is measured in two shapes — clustered (few files, many hits) and scattered (many files, one hit).
// rules: the scattered shape exists because rtk declines a regrouping that is larger than its input; one shape alone would hide that.
// agent: 2026-11-02 initial

// Rules: a tiny LCG keeps the fixture stable across Node versions; Math.random would not.
function seedRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

const DIRS = ['src/core', 'src/lib', 'src/http', 'src/auth', 'src/cache', 'src/routes', 'test/unit', 'test/e2e', 'scripts', 'mods'];

// Rules: clustered is the common real shape — a grep for a common identifier hits the same few files many times.
export function makeGrepClustered(matches = 240, files = 6, seed = 42): string {
	const random = seedRandom(seed);
	const lines: string[] = [];
	for (let index = 0; index < matches; index += 1) {
		const dir = DIRS[index % files];
		const line = 10 + index * 3;
		lines.push(`${dir}/handlers.ts:${line}:  const result = compute(input, options);`);
	}
	for (let index = 0; index < files; index += 1) {
		random();
	}
	return `${lines.join('\n')}\n`;
}

// Rules: scattered is the other real shape — a grep for a rare symbol hits many files once each.
export function makeGrepScattered(matches = 240, seed = 7): string {
	const lines: string[] = [];
	for (let index = 0; index < matches; index += 1) {
		const dir = DIRS[index % DIRS.length];
		lines.push(`${dir}/module${index}.ts:${1 + index}:export const symbol${index} = create(${index});`);
	}
	return `${[...lines].sort().join('\n')}\n`;
}

// Rules: `find` output is one path per line, as a real `find . -type f` prints it.
export function makeFindOutput(files = 260, dirs = 10, seed = 11): string {
	const random = seedRandom(seed);
	const paths = new Set<string>();
	let index = 0;
	while (paths.size < files) {
		const dir = DIRS[index % dirs];
		paths.add(`./${dir}/module${1 + Math.floor(random() * 300)}.ts`);
		index += 1;
	}
	return `${[...paths].sort().join('\n')}\n`;
}

// Rules: the rewrite surface is measured on commands a coding agent actually runs, not synthetic ones.
export const REWRITE_COMMANDS = [
	'git status',
	'git diff',
	'git log --oneline -20',
	'ls -la src',
	'cat package.json',
	'grep -rn TODO src',
	'tree src',
	'find . -name "*.ts"',
	'npm run build',
	'pytest -q',
	'cargo test',
	'docker ps',
];

/* --------------------------------------------------- the host's own tool shapes */

// Rules: these are the exact envelopes Command Code wraps a result in — `glob` opens with a `Found N files` line, `grep` closes with a pagination notice, and `shell_command` opens with the exit status. Measuring only raw `path:line:text` hid that rtk folds the envelope away.

export function makeGlobToolOutput(files = 260, dirs = 10): string {
	const paths = Array.from({length: files}, (_, index) => `./src/d${index % dirs}/f${index}.ts`);
	return `Found ${files} files\n${paths.join('\n')}\n`;
}

export function makeGlobToolTruncated(files = 260, dirs = 10): string {
	const paths = Array.from({length: files}, (_, index) => `  ./src/d${index % dirs}/f${index}.ts`);
	const notice = '(Results are truncated: showing 1-100 of 382 matches, sorted by modification time. Consider using a more specific path or pattern, or retry with offset=100 for the next page.)';
	return `Found 100 files\n${paths.join('\n')}\n${notice}`;
}

export function makeGrepToolTruncated(matches = 240, files = 6): string {
	const lines = Array.from({length: matches}, (_, index) => `src/d${index % files}/handlers.ts:${index + 1}:  const result = compute(input, options);`);
	return `${lines.join('\n')}\n\n[Showing results with pagination = limit: ${matches}]\n`;
}

export function makeShellToolOutput(): string {
	const body = [
		'test result: FAILED. 120 passed; 1 failed; 0 ignored',
		'',
		'failures:',
		'    tests::fails_here',
		'',
		'---- tests::fails_here stdout ----',
		"thread 'tests::fails_here' panicked at src/lib.rs:42:5:",
		'assertion `left == right` failed',
		'  left: 1',
		' right: 2',
		...Array.from({length: 60}, (_, index) => `    note line ${index} that a filter folds away`),
	].join('\n');
	return `Exit code: 1 (test failure)\n${body}\n`;
}

// Rules: grep's default output mode is files_with_matches — a path list under a `Found N files` header, not `path:line:text`. The grep filter passes this shape through untouched, so it is measured separately to keep that 0%/find-win visible.
export function makeGrepFilesModeOutput(files = 300, dirs = 5): string {
	const paths = Array.from({length: files}, (_, index) => `src/d${index % dirs}/f${index}.ts`);
	return `Found ${files} files with pagination = limit: ${files}, offset: ${files}\n${paths.join('\n')}\n`;
}

export function makeGrepCountModeOutput(files = 40, perFile = 10): string {
	const rows = Array.from({length: files}, (_, file) =>
		Array.from({length: perFile}, (_, hit) => `src/file${file}.ts:${hit + 1}:  const x = compute(input)`).join('\n'),
	);
	return `${rows.join('\n')}\n\nFound ${files * perFile} total occurrences across ${files} files with pagination = limit: ${files * perFile}, offset: ${files * perFile}.\n`;
}

// Rules: rtk's search filter prints its faithful baseline when capping would not shrink the output, so a multi-file grep reaches the model at full size. The mod's second pass is measured against exactly that shape: match rows, no recovery marker, no envelope.
export function makeDeclinedBaseline(files = 6, perFile = 25): string {
	return Array.from({length: files}, (_, file) =>
		Array.from({length: perFile}, (_, hit) => `mods/rtk.ts:${file * perFile + hit + 1}:export const value${hit} = compute(input);`).join('\n'),
	).join('\n');
}

export function makeShellAbortOutput(): string {
	const body = [
		'running 3 tests',
		'test tests::it_works ... ok',
		'test tests::fails_here ... FAILED',
		'failures:',
		'    tests::fails_here',
		'test result: FAILED. 2 passed; 1 failed; 0 ignored',
		...Array.from({length: 120}, (_, index) => `    filler line that the filter folds away ${index}`),
	].join('\n');
	return `Exit code: 124\n${body}\n\nCommand timed out after 120000ms (exit code 124). If this is expected to take longer and is not waiting for interactive input, retry with a larger timeout or run_in_background=true.\n`;
}

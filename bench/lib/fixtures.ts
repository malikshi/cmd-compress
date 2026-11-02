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

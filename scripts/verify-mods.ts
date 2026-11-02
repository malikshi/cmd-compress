// verify-mods — loads every package mod through the real Command Code loader, and fails on any load warning.
// exports: none (run directly)
// used_by: npm run verify, CI
// related: package.json, mods/*.ts
// rules: `cmd mods list` is the only proof a mod registered; a load warning means the mod silently did nothing.
// agent: 2026-11-02 initial

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
	commandcode?: {mods?: string[]};
};

const mods = manifest.commandcode?.mods ?? [];
if (mods.length === 0) {
	console.error('verify-mods: package.json declares no commandcode.mods entries');
	process.exit(1);
}

let failed = false;

for (const entry of mods) {
	const file = join(root, entry);
	console.log(`\n=== ${entry}`);
	try {
		const output = execFileSync('cmd', ['mods', 'inspect', file], {encoding: 'utf8', timeout: 120_000});
		process.stdout.write(output);
		if (/warning|error/i.test(output)) {
			console.error(`verify-mods: ${entry} reported a load problem`);
			failed = true;
		}
	} catch (error) {
		console.error(`verify-mods: ${entry} failed to load`);
		console.error(error instanceof Error ? error.message : String(error));
		failed = true;
	}
}

console.log(failed ? '\nverify-mods: FAILED' : '\nverify-mods: all mods load');
process.exit(failed ? 1 : 0);

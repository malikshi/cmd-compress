// verify-mods — loads every package mod for real: imports the file, runs its factory, and fails on a throw or an empty registration.
// exports: none (run directly)
// used_by: npm run verify, CI
// related: package.json, mods/*.ts
// rules: `cmd mods inspect` only reads the source text — it never imports the file or runs the factory, so a mod that throws in its factory passed every check here and in the real host. This script imports each mod and runs its factory against a stub API instead.
// rules: the stub is local on purpose. `test/` is not in package.json's `files`, so importing the test harness here would break `npm run verify` in an installed package.
// rules: a native dynamic import is enough — Node strips TypeScript types without a flag from 22.18.0, which is the floor package.json declares.
// agent: 2026-11-03 replaced the inspect-only check after proving it passes a factory that throws

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
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

// Rules: the stub records what the factory registers and nothing more. A mod reaching for a surface this stub does not model throws here, which is the same fail-loud behaviour the real host gives a bad registration.
function createStubApi() {
	const commands = new Map<string, unknown>();
	const hooks: unknown[] = [];
	const exposed = new Map<string, unknown>();
	const disposable = () => ({dispose() {}});
	const store = new Map<string, unknown>();
	return {
		commands,
		hooks,
		api: {
			name: 'verify',
			cwd: root,
			addFlag: () => disposable(),
			getFlag: () => undefined,
			addCommand: (command: {name: string}) => {
				commands.set(command.name, command);
				return disposable();
			},
			hooks: (next: unknown) => {
				hooks.push(next);
				return disposable();
			},
			expose: (name: string, fn: unknown) => {
				exposed.set(name, fn);
				return disposable();
			},
			use: (mod: string, name: string) => exposed.get(`${mod}/${name}`),
			store: {
				get: (key: string) => store.get(key),
				set: async (key: string, value: unknown) => {
					store.set(key, value);
				},
				delete: async (key: string) => {
					store.delete(key);
				},
			},
			ui: {capabilities: {status: false, surface: false}, setStatus: () => disposable(), notify: () => undefined},
			exec: async () => ({stdout: '', stderr: '', code: 1}),
			on: () => disposable(),
		},
	};
}

let failed = false;

// Rules: `cmd mods inspect` is a source scan, kept for its hooks/reaches report; it cannot prove the mod runs, so it never decides the result.
function inspectReport(file: string): string | null {
	try {
		return execFileSync('cmd', ['mods', 'inspect', file], {encoding: 'utf8', timeout: 120_000});
	} catch {
		return null;
	}
}

for (const entry of mods) {
	const file = join(root, entry);
	console.log(`\n=== ${entry}`);
	try {
		const module = (await import(pathToFileURL(file).href)) as {default?: unknown};
		if (typeof module.default !== 'function') {
			console.error(`verify-mods: ${entry} does not default-export a factory function`);
			failed = true;
			continue;
		}
		const stub = createStubApi();
		(module.default as (cmd: unknown) => void)(stub.api);
		const registered = stub.commands.size + stub.hooks.length;
		if (registered === 0) {
			console.error(`verify-mods: ${entry} registered nothing when its factory ran`);
			failed = true;
			continue;
		}
		console.log(`loaded: factory ran, ${stub.commands.size} command(s), ${stub.hooks.length} hook set(s)`);
		const report = inspectReport(file);
		if (report) process.stdout.write(report);
	} catch (error) {
		console.error(`verify-mods: ${entry} failed to load or its factory threw`);
		console.error(error instanceof Error ? error.message : String(error));
		failed = true;
	}
}

console.log(failed ? '\nverify-mods: FAILED' : '\nverify-mods: every mod imports and its factory runs');
process.exit(failed ? 1 : 0);

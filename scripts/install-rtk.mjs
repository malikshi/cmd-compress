#!/usr/bin/env node
// install-rtk.mjs — fetch a pinned rtk release for the current platform, so CI runs the real-binary tests instead of skipping them.
// exports: none (CLI)
// used_by: .github/workflows/ci.yml
// rules: the version is pinned, not "latest" — a moving binary would turn an upstream release into an unexplained red job.
// rules: a failed download fails the job. Skipping quietly is how eleven tests stopped covering anything without anyone noticing.

import {execFileSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readdirSync, rmSync} from 'node:fs';
import {appendFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const VERSION = '1.1.0';
const BASE = `https://github.com/rtk-ai/rtk/releases/download/v${VERSION}`;

// Rules: the release publishes musl for linux (no glibc build), a darwin build per arch, and a single msvc zip for windows x64.
const ASSETS = {
	'linux-x64': `rtk-x86_64-unknown-linux-musl.tar.gz`,
	'darwin-arm64': `rtk-aarch64-apple-darwin.tar.gz`,
	'darwin-x64': `rtk-x86_64-apple-darwin.tar.gz`,
	'win32-x64': `rtk-x86_64-pc-windows-msvc.zip`,
};

const key = `${process.platform}-${process.arch}`;
const asset = ASSETS[key];
if (!asset) {
	console.error(`install-rtk: no rtk ${VERSION} asset for ${key}. Known: ${Object.keys(ASSETS).join(', ')}`);
	process.exit(1);
}

const dest = resolve(process.env.RTK_INSTALL_DIR ?? join(tmpdir(), `rtk-${VERSION}`));
const work = join(tmpdir(), `rtk-download-${process.pid}`);
mkdirSync(dest, {recursive: true});
mkdirSync(work, {recursive: true});

function fail(step, error) {
	console.error(`install-rtk: ${step} failed — ${error?.message ?? error}`);
	process.exit(1);
}

try {
	const url = `${BASE}/${asset}`;
	console.log(`install-rtk: ${url}`);
	const response = await fetch(url, {redirect: 'follow'});
	if (!response.ok) fail(`download ${response.status}`, url);

	const archive = join(work, asset);
	await writeFile(archive, Buffer.from(await response.arrayBuffer()));

	// Rules: bsdtar (the `tar` on every GitHub runner, windows included) reads both tar.gz and zip, so one call covers every asset.
	execFileSync('tar', ['-xf', archive, '-C', work], {stdio: 'inherit'});

	const binary = findBinary(work);
	if (!binary) fail('extract', `no rtk binary under ${work}: ${readdirSync(work).join(', ')}`);

	const target = join(dest, process.platform === 'win32' ? 'rtk.exe' : 'rtk');
	await rm(target, {force: true});
	execFileSync(process.platform === 'win32' ? 'cmd' : 'cp',
		process.platform === 'win32' ? ['/c', 'copy', binary, target] : [binary, target],
		{stdio: 'inherit'});
	if (process.platform !== 'win32') chmodSync(target, 0o755);

	const reported = execFileSync(target, ['--version'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
	console.log(`install-rtk: ${reported} at ${dest}`);

	// Rules: GITHUB_PATH is how a later workflow step sees the binary; without it the install is invisible to `npm test`.
	if (process.env.GITHUB_PATH) {
		await appendFile(process.env.GITHUB_PATH, `${dest}\n`);
		console.log(`install-rtk: added ${dest} to GITHUB_PATH`);
	}
} catch (error) {
	fail('install', error);
} finally {
	rmSync(work, {recursive: true, force: true});
}

// Rules: the archives keep the binary at the root, but a nested layout would still be found rather than silently missed.
function findBinary(root) {
	const wanted = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let entries;
		try {
			entries = readdirSync(dir, {withFileTypes: true});
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.name === wanted) return full;
		}
	}
	return null;
}

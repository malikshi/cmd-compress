// shared.test.ts — the per-mod store, prompt-block surgery, and path shortening.
// exports: none (node:test)
// used_by: npm test
// related: mods/shared.ts
// rules: the fake store mirrors the harness store's synchronous get / async set so the serialised writer is exercised.
// agent: 2026-11-02 initial; per-mod key after learning each mod gets its own store file

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_MODE,
	readOwnMode,
	writeOwnMode,
	stripBlock,
	wrapBlock,
	shortPaths,
	resolveBin,
} from '../mods/shared.ts';

function fakeStore(initial: Record<string, unknown> = {}) {
	const data = {...initial};
	return {
		data,
		get(key: string) {
			return data[key];
		},
		async set(key: string, value: unknown) {
			data[key] = value;
		},
	};
}

test('readOwnMode: a missing value answers off', () => {
	assert.equal(readOwnMode(fakeStore()), DEFAULT_MODE);
	assert.equal(readOwnMode(fakeStore({mode: ''})), DEFAULT_MODE);
	assert.equal(readOwnMode(fakeStore({mode: 7})), DEFAULT_MODE);
});

test('readOwnMode: a stored mode is returned verbatim', () => {
	assert.equal(readOwnMode(fakeStore({mode: 'ultra'})), 'ultra');
});

test('writeOwnMode: the value lands under the mod-own key only', async () => {
	const store = fakeStore();
	writeOwnMode(store, 'full');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(store.data, {mode: 'full'});
});

test('writeOwnMode: rapid writes keep the last value', async () => {
	const store = fakeStore();
	writeOwnMode(store, 'lite');
	writeOwnMode(store, 'full');
	writeOwnMode(store, 'ultra');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(readOwnMode(store), 'ultra');
});

test('writeOwnMode: a failing set does not break later writes', async () => {
	let calls = 0;
	const store = {
		get: () => undefined,
		async set(_key: string, _value: unknown) {
			calls += 1;
			if (calls === 1) throw new Error('disk full');
		},
	};
	writeOwnMode(store, 'lite');
	writeOwnMode(store, 'full');
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(calls, 2);
});

test('wrapBlock: surrounding whitespace is trimmed and the tag is closed', () => {
	assert.equal(wrapBlock('caveman', '  body  '), '<caveman>\nbody\n</caveman>');
});

test('stripBlock: a previous block is removed and its neighbours kept', () => {
	const prompt = `base\n\n<caveman>\nold\n</caveman>\n\ntail`;
	const stripped = stripBlock(prompt, 'caveman');
	assert.ok(!stripped.includes('<caveman>'));
	assert.ok(!stripped.includes('old'));
	assert.ok(stripped.startsWith('base'));
	assert.ok(stripped.endsWith('tail'));
});

test('stripBlock: re-injecting replaces instead of stacking', () => {
	const once = `base\n\n${wrapBlock('caveman', 'lite rules')}`;
	const twice = `${stripBlock(once, 'caveman')}\n\n${wrapBlock('caveman', 'ultra rules')}`;
	assert.equal((twice.match(/<caveman>/g) ?? []).length, 1);
	assert.ok(twice.includes('ultra rules'));
	assert.ok(!twice.includes('lite rules'));
});

test('shortPaths: the workspace prefix is dropped, longer paths keep their tail', () => {
	assert.equal(shortPaths('edited /repo/src/a.ts', '/repo'), 'edited src/a.ts');
	assert.equal(shortPaths('/repo/src/a.ts:12: err', '/repo'), 'src/a.ts:12: err');
	assert.equal(shortPaths('see /etc/hosts', '/repo'), 'see /etc/hosts');
});

test('resolveBin: a binary that exists on PATH is found, a missing one is null', () => {
	assert.ok(resolveBin('sh'));
	assert.equal(resolveBin('definitely-not-a-real-binary-xyz'), null);
});

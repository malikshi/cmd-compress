// rules.test.ts — the injected rule text: every level exists, is distinct, and keeps its negations.
// exports: none (node:test)
// used_by: npm test
// related: rules/caveman.ts, rules/ponytail.ts
// rules: a mis-ported rule that drops a negation costs more than every token it saves, so negation presence is asserted.
// agent: 2026-11-02 initial

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CAVEMAN_LEVELS, CAVEMAN_RULES, CAVEMAN_DEFAULT, cavemanRule} from '../rules/caveman.ts';
import {PONYTAIL_LEVELS, PONYTAIL_RULES, PONYTAIL_DEFAULT, PONYTAIL_MARKER, ponytailRule} from '../rules/ponytail.ts';

test('caveman: every declared level has a block and they are all distinct', () => {
	const bodies = CAVEMAN_LEVELS.map(level => CAVEMAN_RULES[level]);
	assert.equal(bodies.length, CAVEMAN_LEVELS.length);
	assert.ok(bodies.every(body => body.trim().length > 100));
	assert.equal(new Set(bodies).size, bodies.length);
});

test('caveman: each block names its own level so a switch is unambiguous', () => {
	for (const level of CAVEMAN_LEVELS) {
		assert.ok(CAVEMAN_RULES[level].startsWith(`Caveman ${level} active`), level);
	}
});

test('caveman: the ordinary levels keep the negation rule and the verbatim-payload rule', () => {
	for (const level of ['lite', 'full', 'ultra'] as const) {
		const body = CAVEMAN_RULES[level];
		assert.match(body, /not\/never\/no\/only/, level);
		assert.match(body, /verbatim|exact/, level);
	}
});

test('caveman: megacave levels stay in the classical register and keep their negations', () => {
	for (const level of ['megacave-lite', 'megacave-full', 'megacave-ultra'] as const) {
		const body = CAVEMAN_RULES[level];
		assert.match(body, /文言/, level);
		assert.match(body, /Negation never dropped/, level);
	}
});

test('caveman: an unknown or missing level falls back to the default block', () => {
	assert.equal(cavemanRule('nonsense'), CAVEMAN_RULES[CAVEMAN_DEFAULT]);
	assert.equal(cavemanRule(undefined), CAVEMAN_RULES[CAVEMAN_DEFAULT]);
});

test('ponytail: every level carries the marker and they are all distinct', () => {
	const bodies = PONYTAIL_LEVELS.map(level => PONYTAIL_RULES[level]);
	assert.equal(new Set(bodies).size, bodies.length);
	for (const level of PONYTAIL_LEVELS) {
		assert.ok(PONYTAIL_RULES[level].startsWith(`${PONYTAIL_MARKER} — level: ${level}`), level);
	}
});

test('ponytail: the never-cut list survives in every level', () => {
	for (const level of PONYTAIL_LEVELS) {
		assert.match(PONYTAIL_RULES[level], /Never cut: validation at trust boundaries/, level);
		assert.match(PONYTAIL_RULES[level], /security/, level);
		assert.match(PONYTAIL_RULES[level], /accessibility/, level);
	}
});

test('ponytail: ultra alone pushes back on the request', () => {
	assert.match(PONYTAIL_RULES.ultra, /questions the request/);
	assert.doesNotMatch(PONYTAIL_RULES.full, /questions the request/);
});

test('ponytail: an unknown level falls back to the default block', () => {
	assert.equal(ponytailRule('review'), PONYTAIL_RULES[PONYTAIL_DEFAULT]);
});

// Rules: the rule text is built inside appendSystemPrompt, which must never throw — so every prototype name a person might type must answer the fallback string, not a function, an object, or an exception.
test('both rule lookups: prototype names fall back instead of throwing or returning a non-string', () => {
	const probes = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'toLocaleString'];
	for (const probe of probes) {
		assert.equal(typeof cavemanRule(probe), 'string', `caveman ${probe}`);
		assert.equal(cavemanRule(probe), CAVEMAN_RULES[CAVEMAN_DEFAULT], `caveman ${probe} falls back`);
		assert.equal(typeof ponytailRule(probe), 'string', `ponytail ${probe}`);
		assert.equal(ponytailRule(probe), PONYTAIL_RULES[PONYTAIL_DEFAULT], `ponytail ${probe} falls back`);
	}
});

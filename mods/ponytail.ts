// ponytail — lean-code mode: `/ponytail <level|off|status>` injects one rule block into the prompt.
// exports: default, PONYTAIL_STOP_PHRASES, normalizePonytailLevel
// used_by: package.json (commandcode.mods), mods/compress.ts, test/mods.behaviour.test.ts
// related: rules/ponytail.ts, mods/shared.ts
// rules: exactly one level block is live at a time; the injected text is byte-stable per level so the prompt cache survives.
// agent: unknown | unknown | 2026-11-02 | unknown | ported from DietrichGebert/ponytail SKILL.md (MIT)
// agent: unknown | xai | 2026-11-04 | 01a1a3cc | corrected the used_by test target

import type {ModApi} from '@commandcode/harness';
import {PONYTAIL_DEFAULT, PONYTAIL_LEVELS, ponytailRule, type PonytailLevel} from '../rules/ponytail.ts';
import {announceMode, NORMAL_MODE, OFF, readOwnMode, turnOffSiblings, wrapBlock, writeOwnMode} from './shared.ts';

// Rules: `normal mode` is the upstream phrase for the same thing, so it must work too; the whole message has to be the phrase.
export const PONYTAIL_STOP_PHRASES = new Set(['stop ponytail', 'ponytail off', NORMAL_MODE]);

const LEVELS = new Set<string>(PONYTAIL_LEVELS);

// Rules: `on` means the default level; `review` is a skill, not a runtime level, so it answers null.
export function normalizePonytailLevel(raw: string): PonytailLevel | 'off' | null {
	const value = raw.trim().toLowerCase();
	if (!value || value === 'on') return PONYTAIL_DEFAULT;
	if (value === 'off' || value === 'stop') return OFF;
	return LEVELS.has(value) ? (value as PonytailLevel) : null;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('ponytail', {type: 'string', default: '', description: 'Start mode: lite|full|ultra (default: off)'});

	let mode = readOwnMode(cmd.store, OFF, value => LEVELS.has(value) || value === OFF);

	// Rules: the single write path, announcing on the shared bus so a sibling status line repaints without waiting for the turn boundary.
	function setMode(next: string): void {
		mode = next;
		writeOwnMode(cmd.store, next);
		announceMode(cmd.events);
	}

	cmd.expose('setMode', (next: unknown) => {
		const parsed = typeof next === 'string' ? normalizePonytailLevel(next) : null;
		if (!parsed) return false;
		setMode(parsed);
		return true;
	});
	cmd.expose('getMode', () => mode);

	cmd.addCommand({
		name: 'ponytail',
		description: 'Switch Ponytail intensity: the smallest change that fully works',
		argumentHint: '[lite|full|ultra|off|status]',
		handler: ({args}) => {
			const arg = args.trim().toLowerCase();
			if (arg === 'status') return {message: `Ponytail mode: ${mode}`};
			const parsed = normalizePonytailLevel(arg);
			if (!parsed) return {message: `Unknown ponytail level: ${arg}. Use: lite | full | ultra | off | status`};
			setMode(parsed);
			return {message: parsed === OFF ? 'Ponytail off.' : `Ponytail ${parsed} on.`};
		},
	});

	cmd.hooks({
		// Rules: a flag is a per-session override applied at bind — getFlag answers the default at factory time. The announce keeps the `compress` footer correct when the flag starts this mode, since the host gives no cross-mod ordering guarantee for onSessionStart.
		onSessionStart: () => {
			const flag = String(cmd.getFlag('ponytail') ?? '').trim().toLowerCase();
			const parsed = flag ? normalizePonytailLevel(flag) : null;
			if (parsed) {
				mode = parsed;
				announceMode(cmd.events);
			}
		},

		appendSystemPrompt: () => (mode === OFF ? undefined : wrapBlock('ponytail', ponytailRule(mode))),

		// Rules: `normal mode` ends EVERY mode, so it is answered even when ponytail is already off — caveman normally handles it first, and this is the fallback when caveman is not loaded. Gating it on this mod's own mode would leave a lone `rtk` running.
		transformInput: ({text}) => {
			const phrase = text.trim().toLowerCase();
			if (phrase === NORMAL_MODE) {
				turnOffSiblings(cmd.use, 'ponytail');
				setMode(OFF);
				return {action: 'handled', message: 'All compression modes off.'};
			}
			if (mode === OFF) return undefined;
			if (!PONYTAIL_STOP_PHRASES.has(phrase)) return undefined;
			setMode(OFF);
			return {action: 'handled', message: 'Ponytail off.'};
		},
	});
}

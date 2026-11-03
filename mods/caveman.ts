// caveman — terse-reply mode: `/caveman <level|off|status>` injects one rule block into the prompt.
// exports: default (ModFactory), CAVEMAN_STOP_PHRASES, normalizeCavemanLevel
// used_by: package.json (commandcode.mods), mods/compress.ts, test/caveman.test.ts
// related: rules/caveman.ts, mods/shared.ts
// rules: exactly one level block is live at a time; the injected text is byte-stable per level so the prompt cache survives.
// agent: 2026-11-02 ported from JuliusBrussee/caveman + tersio caveman extension

import type {ModApi} from '@commandcode/harness';
import {CAVEMAN_DEFAULT, CAVEMAN_LEVELS, cavemanRule, type CavemanLevel} from '../rules/caveman.ts';
import {announceMode, NORMAL_MODE, OFF, readOwnMode, turnOffSiblings, wrapBlock, writeOwnMode} from './shared.ts';

// Rules: `normal mode` is the upstream phrase for the same thing, so it must work too; the whole message has to be the phrase.
export const CAVEMAN_STOP_PHRASES = new Set(['stop caveman', 'caveman off', NORMAL_MODE]);

const LEVELS = new Set<string>(CAVEMAN_LEVELS);

// Rules: `on` means the default level; anything unrecognised answers null so the caller can print usage.
export function normalizeCavemanLevel(raw: string): CavemanLevel | 'off' | null {
	const value = raw.trim().toLowerCase();
	if (!value || value === 'on') return CAVEMAN_DEFAULT;
	if (value === 'off' || value === 'stop') return OFF;
	return LEVELS.has(value) ? (value as CavemanLevel) : null;
}

export default function (cmd: ModApi): void {
	cmd.addFlag('caveman', {type: 'string', default: '', description: 'Start mode: lite|full|ultra|megacave-* (default: off)'});

	let mode = readOwnMode(cmd.store, OFF, value => LEVELS.has(value) || value === OFF);

	// Rules: the setter is the single write path (own command, /compress preset) so the session and the store cannot disagree, and it announces on the shared bus so a sibling status line repaints without waiting for the turn boundary.
	function setMode(next: string): void {
		mode = next;
		writeOwnMode(cmd.store, next);
		announceMode(cmd.events);
	}

	cmd.expose('setMode', (next: unknown) => {
		const parsed = typeof next === 'string' ? normalizeCavemanLevel(next) : null;
		if (!parsed) return false;
		setMode(parsed);
		return true;
	});
	cmd.expose('getMode', () => mode);

	cmd.addCommand({
		name: 'caveman',
		description: 'Toggle terse caveman replies for this session',
		argumentHint: '[lite|full|ultra|megacave-lite|megacave-full|megacave-ultra|off|status]',
		handler: ({args}) => {
			const arg = args.trim().toLowerCase();
			if (arg === 'status') return {message: `Caveman mode: ${mode}`};
			const parsed = normalizeCavemanLevel(arg);
			if (!parsed) {
				return {message: `Unknown caveman level: ${arg}. Use: ${[...CAVEMAN_LEVELS, 'off', 'status'].join(' | ')}`};
			}
			setMode(parsed);
			return {message: parsed === OFF ? 'Caveman off.' : `Caveman ${parsed} on.`};
		},
	});

	cmd.hooks({
		// Rules: a flag is a per-session override applied at bind — getFlag answers the default at factory time.
		// Rules: the announce matters here too: `compress` paints the footer from its own onSessionStart, and the host gives no ordering guarantee between mods, so without it a `--mod-option caveman=ultra` start can leave the footer showing the pre-flag state until the first turn ends.
		onSessionStart: () => {
			const flag = String(cmd.getFlag('caveman') ?? '').trim().toLowerCase();
			const parsed = flag ? normalizeCavemanLevel(flag) : null;
			if (parsed) {
				mode = parsed;
				announceMode(cmd.events);
			}
		},

		appendSystemPrompt: () => (mode === OFF ? undefined : wrapBlock('caveman', cavemanRule(mode))),

		// Rules: the stop phrase must be the whole message, so "add a caveman off toggle" never disables it.
		// Rules: `normal mode` ends EVERY mode, so it is answered even when caveman is already off — otherwise it would fall through the chain and leave a lone `rtk` running. The host stops the chain at the first `handled`, so the siblings are turned off here rather than by their own hooks.
		transformInput: ({text}) => {
			const phrase = text.trim().toLowerCase();
			if (phrase === NORMAL_MODE) {
				turnOffSiblings(cmd.use, 'caveman');
				setMode(OFF);
				return {action: 'handled', message: 'All compression modes off.'};
			}
			if (mode === OFF) return undefined;
			if (!CAVEMAN_STOP_PHRASES.has(phrase)) return undefined;
			setMode(OFF);
			return {action: 'handled', message: 'Caveman off.'};
		},
	});
}

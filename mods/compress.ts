// compress — one preset for all three modes, plus the live status line.
// exports: default (ModFactory), COMPRESS_PRESETS, presetFor
// used_by: package.json (commandcode.mods), test/compress.test.ts
// related: mods/caveman.ts, mods/ponytail.ts, mods/rtk.ts
// rules: a preset is applied through each mode's exposed setMode, so the three mods stay the only writers of their own state.
// rules: status reads each sibling's getMode live; reading cmd.store would see only this mod's own file.
// agent: 2026-11-02 ported from tersio /combo

import type {ModApi} from '@commandcode/harness';
import {MODE_EVENT, MODES, type ModeName} from './shared.ts';

export interface Preset {
	readonly caveman: string;
	readonly ponytail: string;
	readonly rtk: string;
}

// Rules: the names follow the upstream combo reference (KurutoDenzeru/tersio: off | medium | balanced | max), so a person moving between the two tools types the same word; `lite` stays as an alias because earlier releases of this package taught it.
export const COMPRESS_PRESETS: Record<string, Preset> = {
	off: {caveman: 'off', ponytail: 'off', rtk: 'off'},
	medium: {caveman: 'lite', ponytail: 'lite', rtk: 'on'},
	lite: {caveman: 'lite', ponytail: 'lite', rtk: 'on'},
	balanced: {caveman: 'full', ponytail: 'full', rtk: 'on'},
	max: {caveman: 'ultra', ponytail: 'ultra', rtk: 'on'},
};

export function presetFor(raw: string): Preset | null {
	const key = raw.trim().toLowerCase();
	if (!key) return COMPRESS_PRESETS.balanced ?? null;
	return Object.hasOwn(COMPRESS_PRESETS, key) ? (COMPRESS_PRESETS[key] ?? null) : null;
}

type Setter = (value: unknown) => boolean;
type Getter = () => string;

export default function (cmd: ModApi): void {
	// Rules: use() answers undefined until the sibling mod loads, so every lookup happens at command time, not factory time.
	const setter = (name: ModeName): Setter | undefined => cmd.use(name, 'setMode') as Setter | undefined;
	const getter = (name: ModeName): Getter | undefined => cmd.use(name, 'getMode') as Getter | undefined;

	function snapshot(): Record<ModeName, string> {
		const read = (name: ModeName) => getter(name)?.() ?? '?';
		return {caveman: read('caveman'), ponytail: read('ponytail'), rtk: read('rtk')};
	}

	// Rules: `rtk=on` alone overstates the session. The rtk mod stores the request, but it condenses nothing when the binary is missing or too old, and this one line is where a person reads all three. The state is annotated rather than replaced, so the requested mode stays visible, and the annotation names the actual reason because the two failures need different fixes.
	function snapshotWithAvailability(): Record<ModeName, string> {
		const state = snapshot();
		const inactive = cmd.use('rtk', 'inactiveReason') as (() => string | null) | undefined;
		const reason = state.rtk === 'off' ? null : inactive?.();
		return reason ? {...state, rtk: `${state.rtk} (${reason})`} : state;
	}

	function line(state: Record<ModeName, string>): string {
		return `caveman=${state.caveman} | ponytail=${state.ponytail} | rtk=${state.rtk}`;
	}

	cmd.addCommand({
		name: 'compress',
		description: 'Set caveman, ponytail and rtk together, or show their state',
		argumentHint: '[off|medium|balanced|max|status]',
		handler: ({args}) => {
			const arg = args.trim().toLowerCase();

			if (!arg || arg === 'status') return {message: `compress: ${line(snapshotWithAvailability())}`};

			if (arg === 'help') {
				return {
					message: [
						'/compress medium    caveman=lite, ponytail=lite, rtk=on',
						'/compress balanced  caveman=full, ponytail=full, rtk=on',
						'/compress max       caveman=ultra, ponytail=ultra, rtk=on',
						'/compress off       all three off',
						'Each mode still has its own command: /caveman, /ponytail, /rtk',
					].join('\n'),
				};
			}

			const preset = presetFor(arg);
			if (!preset) return {message: `Unknown preset: ${arg}. Use: off | medium | balanced | max | status`};

			const missing: ModeName[] = [];
			for (const name of MODES) {
				const setMode = setter(name);
				if (!setMode) missing.push(name);
				else setMode(preset[name]);
			}
			// Rules: report the state that is actually in effect, not the preset that was requested — with a sibling missing the two differ, and printing the preset beside "not loaded" claims a change that did not happen.
			const summary = `compress ${arg}: ${line(snapshotWithAvailability())}`;
			return {message: missing.length ? `${summary} (not loaded: ${missing.join(', ')})` : summary};
		},
	});

	// Rules: one footer segment for all three — three segments would crowd the row the prompt already owns.
	// Rules: repaint on the shared mode event as well as on the turn boundary. A `/caveman ultra` or a preset set from the prompt changes a sibling's mode between turns, and `onRunEnd` would leave the footer claiming the old state until the turn finished.
	cmd.hooks({
		onSessionStart: () => paint(),
		onRunEnd: () => paint(),
	});

	try {
		cmd.events?.on(MODE_EVENT, () => paint());
	} catch {
		// a host without the bus keeps the turn-boundary repaint
	}

	function paint(): void {
		if (!cmd.ui.capabilities.status) return;
		const state = snapshot();
		const off = state.caveman === 'off' && state.ponytail === 'off' && state.rtk === 'off';
		cmd.ui.setStatus(off ? 'compress off' : `caveman=${state.caveman} pony=${state.ponytail} rtk=${state.rtk}`);
	}
}

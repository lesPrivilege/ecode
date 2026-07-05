/**
 * The 4 experiment arms as concrete, verifiable session configuration.
 *
 * | Arm | Native pi compaction | Seam-A hook | Seam-B |
 * | --- | -------------------- | ----------- | ------ |
 * |  A  | OFF (disabled)       | no          | no     |  no-compaction baseline
 * |  B  | ON  (pi default)     | no          | no     |  pi's own LLM summariser
 * |  C  | OFF                  | yes         | no     |  G1b seam A only (isolated)
 * |  D  | ON  (seam-B intercepts) | yes      | yes    |  seam A + deterministic seam-B checkpoint
 *
 * Note on arm D's native=ON: seam B is the `session_before_compact` hook, which
 * only fires when native compaction TRIGGERS; it then replaces pi's LLM summary
 * with a deterministic no-model checkpoint. So arm D keeps native enabled to make
 * the trigger fire, and seam B intercepts it — no LLM summariser call happens.
 *
 * Arm A's "disable native compaction" — how it was resolved (see run.ts report):
 *   pi's AUTO-compaction trigger is gated in
 *   coding-agent/src/core/agent-session.ts `_checkCompaction`:
 *       const settings = this.settingsManager.getCompactionSettings();
 *       if (!settings.enabled) return false;   // :1842-1843
 *   and `getCompactionSettings()` reads `settings.compaction.enabled` from the
 *   SettingsManager (settings-manager.ts:756-783), defaulting true. The hardcoded
 *   `DEFAULT_COMPACTION_SETTINGS.enabled = true` in agent/.../compaction.ts is only
 *   the fallback used by the low-level `harness.compact()` primitive; the app-level
 *   auto-trigger honours the SettingsManager. So arm A is achieved WITHOUT patching
 *   pi, via the public setter `settingsManager.setCompactionEnabled(false)` (which
 *   sets `compaction.enabled=false`). Arms C/D also disable native compaction so the
 *   seam-A hook is the only mechanism in play (otherwise pi's summariser and the hook
 *   would both fire and the comparison would be confounded); arm B leaves it ON.
 *
 * Nothing here binds to a specific provider — the caller supplies the provider
 * factory. That keeps the mock↔real swap a config change (G2), not a code change.
 */

export type ArmId = "A" | "B" | "C" | "D";

export interface ArmDefinition {
	id: ArmId;
	label: string;
	/** Native pi auto-compaction enabled (settingsManager.setCompactionEnabled). */
	nativeCompactionEnabled: boolean;
	/** Install G1b's seam-A `context` hook. */
	seamAInstalled: boolean;
	/** Install G1b's seam-B `session_before_compact` checkpoint. */
	seamBInstalled: boolean;
}

export const ARMS: Record<ArmId, ArmDefinition> = {
	A: {
		id: "A",
		label: "native-off / no-hook (baseline)",
		nativeCompactionEnabled: false,
		seamAInstalled: false,
		seamBInstalled: false,
	},
	B: {
		id: "B",
		label: "native-on / no-hook (pi default summariser)",
		nativeCompactionEnabled: true,
		seamAInstalled: false,
		seamBInstalled: false,
	},
	C: {
		id: "C",
		label: "seam-A hook / seam-B off",
		nativeCompactionEnabled: false,
		seamAInstalled: true,
		seamBInstalled: false,
	},
	D: {
		id: "D",
		// Seam B is the `session_before_compact` hook: it only fires when pi's
		// native compaction TRIGGERS, and it REPLACES pi's LLM summariser with a
		// deterministic, no-model checkpoint (seam-b.ts). So arm D must leave native
		// compaction ENABLED (so the trigger fires) — seam B then intercepts it.
		// That is the difference from arm C, where native is off and only seam A's
		// per-call projection runs. Arm D = seam-A projection + native-triggered
		// deterministic seam-B checkpoint.
		label: "seam-A hook + native-triggered seam-B checkpoint",
		nativeCompactionEnabled: true,
		seamAInstalled: true,
		seamBInstalled: true,
	},
};

export const ALL_ARMS: ArmId[] = ["A", "B", "C", "D"];

export function isArmId(x: string): x is ArmId {
	return x === "A" || x === "B" || x === "C" || x === "D";
}

/** Seam-A sweep surface: the required 4 threshold values. */
export const SWEEP_COMPACT_AFTER_VALUES = [4000, 16000, 32000, 64000] as const;
export type SweepValue = (typeof SWEEP_COMPACT_AFTER_VALUES)[number];

export const DEFAULT_COMPACT_AFTER_INPUT_TOKENS = 32000;
export const DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES = 3;

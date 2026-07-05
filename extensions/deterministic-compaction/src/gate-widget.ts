/**
 * Gate widget for the deterministic-compaction extension.
 *
 * Displays a one-line strip showing the current gate status: raw tokens vs
 * threshold, trigger state, and last projection savings (when active).
 *
 * The widget is a pure function of the {@link gateStatus} holder — no TUI
 * dependency needed to test the render output.
 */

// ---- live gate line (shared between seam-A hook and widget) ----------------

/**
 * Latest gate status read by the widget component on each render.
 * Updated every turn inside the seam-A context hook.
 */
export interface GateStatus {
	rawTokens: number | null;
	threshold: number;
	triggerState: "waiting" | "active" | "off" | "no_data";
	/** tokensSaved from the most recent compacting projection; null until first real trigger. */
	lastSavedTokens: number | null;
	/** effectiveSavedPct from the most recent compacting projection; null until first real trigger. */
	lastSavedPct: number | null;
	/** Current keep-recent-assistant-messages value; null until first context hook run. */
	keepRecent: number | null;
}

/** Mutable gate status singleton, updated by the seam-A hook every turn. */
export const gateStatus: GateStatus = {
	rawTokens: null,
	threshold: 32000,
	triggerState: "no_data",
	lastSavedTokens: null,
	lastSavedPct: null,
	keepRecent: null,
};

/** @internal Guards against double-registration. */
let gateWidgetRegistered = false;

/**
 * Pure render: returns the strip lines for the gate widget.
 * Reads from the module-level {@link gateStatus} holder.
 *
 * @param _width — available column width (unused; the strip is self-sizing).
 */
export function renderGateWidget(_width: number): string[] {
	const { rawTokens, threshold, triggerState, keepRecent } = gateStatus;
	if (rawTokens === null || triggerState === "no_data") {
		return ["⟨compaction⟩ gate — / — compactable · —"];
	}
	const fmt = (n: number): string => n.toLocaleString();
	let line = `⟨compaction⟩ gate ${fmt(rawTokens)} / ${fmt(threshold)} compactable · ${triggerState}`;
	if (gateStatus.lastSavedTokens !== null) {
		line += ` · last −${fmt(gateStatus.lastSavedTokens)} (${gateStatus.lastSavedPct}%)`;
	}
	if (keepRecent !== null) {
		line += ` · keep=${keepRecent}`;
	}
	return [line];
}

/**
 * Register the gate widget on a TUI-capable context.
 * Safe to call multiple times — only registers once.
 *
 * The factory signature matches pi's `ui.setWidget(id, (tui, theme) => Widget)`.
 */
export function registerGateWidget(ui: { setWidget: (id: string, factory: (tui: unknown, theme: unknown) => { render: typeof renderGateWidget; height: number }) => void }): void {
	if (gateWidgetRegistered) return;
	ui.setWidget("compaction-gate", (_tui: unknown, _theme: unknown) => ({
		render: renderGateWidget,
		get height(): number {
			return 1;
		},
	}));
	gateWidgetRegistered = true;
}

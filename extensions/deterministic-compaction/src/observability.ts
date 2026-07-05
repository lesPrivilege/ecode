/**
 * Observability (DF1, tasks 1 & 2) — surfaces what the seam-A `context` hook
 * decided, ported from taucode's three TUI slash commands (packages/tui/src/app.ts
 * ~722-760) to pi `registerCommand` registrations, plus a visible trigger-marker
 * line for the turn a projection actually fires.
 *
 * This module adds NO report logic of its own. It reconstructs the current
 * session transcript, runs the SAME projection compaction-core already performs
 * (`projectCompaction`), and formats the result with compaction-core's own
 * `formatCompactionProjectionReport` / `formatCompactionReviewJson`. The commands
 * are wiring + display only.
 *
 * Semantic port (taucode -> pi):
 *   /compact-status  -> command "compact-status"  (trigger state, raw vs compacted
 *                       tokens, gate position relative to threshold)
 *   /compact-diff    -> command "compact-diff"    (per-replacement diff this turn)
 *   /compact-report  -> command "compact-report"  ("json" arg => full JSON payload,
 *                       else diff + hint), branching on args exactly like taucode's
 *                       `cmdArgs[0] === "json"`.
 *
 * Output convention: pi command handlers return void and surface text via the UI.
 * Short confirmations use `ctx.ui.notify`; the multi-line reports are put into the
 * transcript as a rendered custom message via `pi.sendMessage({ customType,
 * content, display:true })` — the same primitive the trigger marker uses and the
 * closest analogue to taucode "printing" the report to the scrollback. Registering
 * a `registerMessageRenderer` for that customType keeps report + marker styled and
 * out of the LLM context (custom messages with display:true render but do not
 * re-enter the model payload unless triggerTurn is set, which we never do).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	EntryRenderer,
	ExtensionAPI,
	ExtensionCommandContext,
	MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
	buildCompactionReviewPayload,
	formatCompactionProjectionReport,
	formatCompactionReviewJson,
	projectCompaction,
	type CompactionProjectionReport,
} from "./compaction-core.js";
import { toCore } from "./adapter.js";
import type { ProjectionConfig } from "./projection.js";

/**
 * customType for command REPORT output (a `sendMessage` custom MESSAGE, rendered
 * by a MessageRenderer). Reports are emitted from command handlers while the
 * agent is idle, so `sendMessage` is safe there.
 */
export const OBSERVABILITY_MESSAGE_TYPE = "deterministic-compaction:report";

/**
 * customType for the TRIGGER MARKER (a `appendEntry` custom ENTRY, rendered by an
 * EntryRenderer). CRITICAL: the marker is emitted from inside the `context` hook
 * WHILE the agent is streaming. `sendMessage` during streaming STEERS the agent
 * (agent-session.ts sendCustomMessage -> agent.steer), which would re-loop the
 * agent every projecting turn (infinite loop / OOM). A custom ENTRY is pure
 * persistence + a UI event: it does NOT steer and does NOT enter LLM context
 * (session-manager.ts CustomEntry doc), so it is the correct primitive for a
 * transcript-only marker line.
 */
export const OBSERVABILITY_TRIGGER_TYPE = "deterministic-compaction:trigger";

/** Details carried on an observability report message. */
export interface ObservabilityMessageDetails {
	kind: "report";
}

/** Data carried on a trigger-marker custom entry. */
export interface TriggerMarkerData {
	/** The turn the projection fired on (1-based). */
	turn: number;
	/** How many replacements were made this projection. */
	compactedCount: number;
	/** Effective tokens saved this projection. */
	effectiveTokensSaved: number;
	/** Raw context tokens that crossed the gate. */
	rawTokens: number;
	/** The gate threshold that was crossed. */
	compactAfterInputTokens: number;
}

/**
 * Shared, mutable state the `context` hook writes each turn so command handlers
 * can report on the SAME config/threshold the hook uses. The transcript itself is
 * re-read live from the session on each command (matching taucode, which reports
 * against the current session each time), so we only need the config here plus a
 * turn counter for the marker.
 */
export interface ObservabilityState {
	/** The projection config the seam-A hook is running with. */
	config: ProjectionConfig;
	/** Incremented once per `context` firing; the marker stamps the current value. */
	turnCounter: number;
}

/**
 * Reconstruct the current session's LLM transcript as `AgentMessage[]`.
 *
 * Reads the persisted session entries (the RAW, unprojected history — the on-disk
 * ground truth) and pulls out the message entries in order. This is what the
 * commands report against, exactly like taucode's commands read `currentSession`.
 */
export function transcriptFromContext(ctx: ExtensionCommandContext): AgentMessage[] {
	const entries = ctx.sessionManager.getEntries();
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") {
			messages.push((entry as { message: AgentMessage }).message);
		}
	}
	return messages;
}

/**
 * Build a `CompactionProjectionReport` for a transcript under a config. This is
 * the single place that adapts the pi transcript to compaction-core's projection
 * entry point; it does NOT re-implement any compaction — it calls
 * `projectCompaction`, feeding the same estimator and injection the live seam-A
 * hook uses so the numbers match what a real send would produce.
 *
 * `enabled` is true here (the extension is loaded); the trigger state then comes
 * from the gate: below `compactAfterInputTokens` => "waiting", at/above =>
 * "active", mirroring the hook's own gating.
 */
export function buildReport(messages: AgentMessage[], config: ProjectionConfig): CompactionProjectionReport {
	const core = toCore(messages);
	// compaction-core's projectCompaction runs its OWN estimator over core messages
	// for the compacted size; we pass a matching char-based estimator (~4 chars/tok,
	// same as the projection-report test) and drive the gate with that SAME estimate
	// so the raw and compacted numbers share one base and the trigger decision here
	// matches projectCompaction's internal accounting exactly (apples-to-apples).
	//
	// NB the LIVE seam-A hook gates on pi's estimateContextTokens instead; the two
	// estimators differ in absolute base by design. This report is a faithful
	// projection of WHAT gets compacted, not a byte-exact replay of the hook's gate.
	const estimateTokens = (msgs: typeof core.coreMessages): number =>
		msgs.reduce((sum, m) => {
			let chars = (m.content ?? "").length;
			for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
			return sum + Math.ceil(chars / 4);
		}, 0);

	return projectCompaction({
		messages: core.coreMessages,
		rawTokens: estimateTokens(core.coreMessages),
		estimateTokens,
		enabled: true,
		compactAfterInputTokens: config.compactAfterInputTokens,
		compactionOptions: config.compactionOptions,
	});
}

/** Push a multi-line report into the transcript as a rendered custom message. */
function emitReport(pi: ExtensionAPI, content: string): void {
	pi.sendMessage<ObservabilityMessageDetails>({
		customType: OBSERVABILITY_MESSAGE_TYPE,
		content,
		display: true,
		details: { kind: "report" },
	});
}

/**
 * Build the exact text `/compact-status` shows: current trigger state, raw vs
 * compacted token counts, and gate position relative to the threshold. Uses
 * compaction-core's `formatCompactionProjectionReport` (no diffs) verbatim, then
 * appends a one-line explicit gate delta so "how far from the threshold" is plain.
 */
export function formatStatus(report: CompactionProjectionReport): string {
	const base = formatCompactionProjectionReport(report, { includeDiffs: false });
	const threshold = report.triggerTokens;
	let gateLine: string;
	if (threshold === undefined) {
		gateLine = "  Gate: no threshold set (always active)";
	} else {
		const delta = report.rawTokens - threshold;
		gateLine =
			delta >= 0
				? `  Gate: +${delta.toLocaleString()} tokens OVER threshold (${report.rawTokens.toLocaleString()} >= ${threshold.toLocaleString()}) -> ${report.triggerState}`
				: `  Gate: ${Math.abs(delta).toLocaleString()} tokens UNDER threshold (${report.rawTokens.toLocaleString()} < ${threshold.toLocaleString()}) -> ${report.triggerState}`;
	}
	return `${base}\n${gateLine}`;
}

/** `/compact-diff` text: the projection report WITH the per-replacement diff. */
export function formatDiff(report: CompactionProjectionReport): string {
	return formatCompactionProjectionReport(report, { includeDiffs: true });
}

/**
 * `/compact-report` text. With `json`, the full structured review payload
 * (`formatCompactionReviewJson`); without, the diff plus a hint to add `json` —
 * exactly taucode's branch.
 */
export function formatReport(report: CompactionProjectionReport, json: boolean): string {
	if (json) {
		return formatCompactionReviewJson(report);
	}
	return `${formatDiff(report)}\n\nUse \`/compact-report json\` for a reviewable JSON payload.`;
}

/** The structured payload backing the JSON report (exposed for tests/DF2). */
export function reportPayload(report: CompactionProjectionReport) {
	return buildCompactionReviewPayload(report);
}

/** Minimal structural type of the pi-tui components the renderers use. */
export interface TuiComponents {
	Box: new (padX: number, padY: number, bg?: (t: string) => string) => any;
	Text: new (text: string, x?: number, y?: number) => any;
}

/**
 * One human-readable marker line for a trigger-marker entry's data. Exposed so
 * tests can assert the exact line without a TUI.
 */
export function formatTriggerMarkerLine(data: TriggerMarkerData): string {
	return `[compaction fired] turn ${data.turn}: ${data.compactedCount} replacement(s), ~${data.effectiveTokensSaved.toLocaleString()} tokens saved (gate ${data.rawTokens.toLocaleString()}/${data.compactAfterInputTokens.toLocaleString()})`;
}

/**
 * MessageRenderer for command REPORT output. Renders the formatted report text
 * under a dim label. Returns undefined for unknown shapes so pi falls back to
 * default rendering.
 *
 * The pi-tui `Box`/`Text` constructors are injected so this module keeps no hard
 * `@earendil-works/pi-tui` import (minimal import graph for jiti; tests can drive
 * the format helpers without a TUI). extension.ts wires the real components.
 */
export function makeReportRenderer(components: TuiComponents): MessageRenderer<ObservabilityMessageDetails> {
	const { Box, Text } = components;
	return (message, _options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		const label = theme.fg("customMessageLabel", "\x1b[1m[compaction]\x1b[22m");
		box.addChild(new Text(label, 0, 0));
		for (const line of content.split("\n")) {
			box.addChild(new Text(line, 0, 0));
		}
		return box;
	};
}

/**
 * EntryRenderer for the TRIGGER MARKER. Renders one highlighted line (turn,
 * replacements, tokens saved, gate position). Custom entries do not participate
 * in LLM context, so this line is transcript-only.
 */
export function makeTriggerRenderer(components: TuiComponents): EntryRenderer<TriggerMarkerData> {
	const { Box, Text } = components;
	return (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
		const label = theme.fg("success", "\x1b[1m[compaction fired]\x1b[22m");
		const parts = [
			`turn ${data.turn}`,
			`${data.compactedCount} replacement(s)`,
			`~${data.effectiveTokensSaved.toLocaleString()} tokens saved`,
			`gate ${data.rawTokens.toLocaleString()}/${data.compactAfterInputTokens.toLocaleString()}`,
		];
		box.addChild(new Text(`${label} ${parts.join("  |  ")}`, 0, 0));
		if (expanded) {
			box.addChild(new Text(theme.fg("dim", "  seam-A projected this send; on-disk history is unchanged"), 0, 0));
		}
		return box;
	};
}

/**
 * Emit the trigger-marker line for a projection that ACTUALLY fired this turn.
 * Called from the seam-A `context` hook the moment it detects a real projection.
 *
 * Uses `pi.appendEntry` (a custom ENTRY), NOT `pi.sendMessage`: the hook runs
 * mid-stream and `sendMessage` would steer the agent (see OBSERVABILITY_TRIGGER_TYPE
 * doc). A custom entry persists + emits a UI event only — transcript-visible,
 * never steering, never in LLM context.
 */
export function emitTriggerMarker(pi: ExtensionAPI, data: TriggerMarkerData): void {
	pi.appendEntry<TriggerMarkerData>(OBSERVABILITY_TRIGGER_TYPE, data);
}

/**
 * Register the three observability commands on the ExtensionAPI. The renderer is
 * registered by extension.ts (which owns the pi-tui import); the commands here
 * only need `pi.sendMessage` + `ctx.sessionManager`, both always available.
 */
export function registerObservabilityCommands(pi: ExtensionAPI, state: ObservabilityState): void {
	pi.registerCommand("compact-status", {
		description: "Show deterministic-compaction trigger state and token gate position",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = buildReport(transcriptFromContext(ctx), state.config);
			emitReport(pi, formatStatus(report));
		},
	});

	pi.registerCommand("compact-diff", {
		description: "Show what deterministic-compaction would replace in the current context",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = buildReport(transcriptFromContext(ctx), state.config);
			emitReport(pi, formatDiff(report));
		},
	});

	pi.registerCommand("compact-report", {
		description: "Compaction report; pass `json` for a full structured payload",
		getArgumentCompletions: (prefix: string) =>
			"json".startsWith(prefix) ? [{ value: "json", label: "json" }] : null,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const wantJson = args.trim() === "json";
			const report = buildReport(transcriptFromContext(ctx), state.config);
			emitReport(pi, formatReport(report, wantJson));
		},
	});
}

/**
 * deterministic-compaction — a pi extension (seam A + optional seam B).
 *
 * Seam A (`context` hook): on every LLM call, hybrid-gated deterministic
 * compaction is applied to the outgoing send payload. Below the token threshold
 * messages pass through unchanged (prefix-cache preservation); at/above it,
 * large write/edit tool-call arguments and read/bash/search/find results are
 * replaced with compact summaries via @ecode/compaction-core. The hook return
 * is a send-time projection only and never persisted (docs/g0-survey.md Item 3).
 *
 * Seam B (`session_before_compact`): OPTIONAL and OFF by default. When enabled,
 * it replaces pi's default LLM summarisation with a deterministic, self-contained
 * checkpoint manifest (no model call). Correction #3: once persisted with
 * `fromHook: true`, pi skips re-deriving file-ops from this entry on the next
 * pass, so the summary is written to be fully self-contained.
 *
 * Configuration (env vars so it works identically under the CLI and in tests):
 *   ECODE_COMPACT_AFTER_INPUT_TOKENS   number, default 32000 — seam A gate
 *   ECODE_KEEP_RECENT_ASSISTANT_MSGS   number, default 3     — protection window
 *   ECODE_SEAM_B                        "1"/"true" to enable seam B (default off)
 *
 * Loading an extension that lives OUTSIDE the pi-mono tree:
 *   pi --extension /abs/path/to/extensions/deterministic-compaction/src/extension.ts
 * pi's loader resolves the path via `resolvePath` and imports the `.ts` through
 * jiti (loader.ts:381-406); jiti's alias map points `@earendil-works/*` imports
 * at pi's own workspace, so the external file needs no pi dependency of its own.
 * The default export is the `ExtensionFactory = (pi: ExtensionAPI) => void`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Box, Text } from "@earendil-works/pi-tui";
import { gateStatus, registerGateWidget } from "./gate-widget.js";
import type { CompactionOptions } from "./compaction-core.js";
import { estimateAgentTokens, projectContext, type ProjectionConfig } from "./projection.js";
import { buildSeamBCheckpoint, type SeamBInput } from "./seam-b.js";
import {
	emitTriggerMarker,
	makeReportRenderer,
	makeTriggerRenderer,
	OBSERVABILITY_MESSAGE_TYPE,
	OBSERVABILITY_TRIGGER_TYPE,
	registerObservabilityCommands,
	type ObservabilityState,
} from "./observability.js";
import {
	AmbientCollector,
	appendAmbientRow,
	AMBIENT_SCHEMA_FAMILY,
	AMBIENT_SCHEMA_VERSION,
	type AmbientTuningRow,
	type AppendAmbientRowOptions,
	type AssistantLike,
} from "./ambient-telemetry.js";
import {
	estimateContextTokensNow,
	parseTuningCommand,
	persistTuning,
	recordTuningEvent,
	TuningState,
	TUNING_COMPLETIONS,
	type PersistOptions,
	type TuningTelemetry,
} from "./tuning.js";

const DEFAULT_COMPACT_AFTER_INPUT_TOKENS = 32000;
const DEFAULT_KEEP_RECENT_ASSISTANT_MSGS = 3;


function readNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readBoolEnv(name: string): boolean {
	const raw = (process.env[name] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface DeterministicCompactionConfig extends ProjectionConfig {
	seamBEnabled: boolean;
}

export function resolveConfig(): DeterministicCompactionConfig {
	const compactionOptions: Partial<CompactionOptions> = {
		keepRecentAssistantMessages: readNumberEnv(
			"ECODE_KEEP_RECENT_ASSISTANT_MSGS",
			DEFAULT_KEEP_RECENT_ASSISTANT_MSGS,
		),
	};
	return {
		compactAfterInputTokens: readNumberEnv("ECODE_COMPACT_AFTER_INPUT_TOKENS", DEFAULT_COMPACT_AFTER_INPUT_TOKENS),
		compactionOptions,
		seamBEnabled: readBoolEnv("ECODE_SEAM_B"),
	};
}

/**
 * Options for {@link installDeterministicCompaction} controlling the DF1
 * observability + telemetry layer. All optional so existing callers (smoke /
 * seam-b tests) keep working with `(pi, config)`.
 */
export interface InstallOptions {
	/**
	 * Ambient telemetry. Default ON. When on, one G1c-schema-shaped JSONL row per
	 * session is written to `experiments/results/ambient/` (local only, gitignored)
	 * after the session ends. The `compaction telemetry off` command disables it
	 * for the rest of the session.
	 */
	telemetry?: {
		/** Start disabled. Default false (telemetry ON by default). */
		disabled?: boolean;
		/** Override output dir / filename for tests. Defaults to the ambient dir. */
		writeOptions?: AppendAmbientRowOptions;
		/** Injected writer (tests). Defaults to {@link appendAmbientRow}. */
		write?: (row: ReturnType<AmbientCollector["buildRow"]>, opts?: AppendAmbientRowOptions) => string;
	};
	/** Register the observability commands + trigger-marker renderer. Default true. */
	observability?: boolean;
	/**
	 * DF2 tuning-event logging + optional settings persistence. All optional.
	 * Tuning rows are appended to the SAME ambient JSONL via DF1's writer; a test
	 * may inject `write`/`writeOptions` to redirect them (mirrors `telemetry`).
	 */
	tuning?: {
		/** Injected tuning-row writer (tests). Defaults to DF1's {@link appendAmbientRow}. */
		write?: (row: AmbientTuningRow, opts?: AppendAmbientRowOptions) => string;
		/** Override output dir / filename for tuning rows (tests). */
		writeOptions?: AppendAmbientRowOptions;
		/**
		 * Enable best-effort persistence of tuning knobs to `<cwd>/.pi/settings.json`.
		 * OFF by default (persistence is not read back by this extension and would
		 * touch a real settings file, so it is strictly opt-in). When true, each
		 * state-changing tuning command also writes the namespaced settings block.
		 */
		persist?: boolean;
		/** Override the persistence target dir name (defaults to ".pi"). */
		configDirName?: string;
	};
}

/** Handle returned by the installer so tests can inspect/flush telemetry directly. */
export interface InstalledHandle {
	/** The shared observability state (config + turn counter). */
	observabilityState: ObservabilityState;
	/** The live ambient collector for this install. */
	telemetry: AmbientCollector;
	/** Whether telemetry is currently enabled (mutates when toggled off). */
	isTelemetryEnabled: () => boolean;
	/** Append the current cumulative ambient row now; returns the file path or undefined (disabled/no data). */
	flushTelemetry: (sessionId: string) => string | undefined;
	/**
	 * DF2 live tuning state (seam-A on/off + keep-recent / compact-after). Mutates
	 * when a `/compaction set|on|off` command runs; the seam-A hook reads through it.
	 */
	tuning: TuningState;
}

/** Read compacted READ-result paths out of a projection's diffs (for re-read tracking). */
function compactedReadPaths(outcome: ReturnType<typeof projectContext>): string[] {
	const diffs = outcome.compaction?.diffs ?? [];
	const paths: string[] = [];
	for (const d of diffs) {
		if (d.toolName === "read" && typeof d.path === "string") paths.push(d.path);
	}
	return paths;
}

/**
 * Register the deterministic-compaction hooks on an ExtensionAPI.
 *
 * Exposed separately from the default export so tests can install the hooks on
 * a programmatically-created session with an explicit config, bypassing env.
 *
 * DF1 additions (observability + telemetry) sit ON TOP of the existing seam-A
 * projection: the `context` hook still calls `projectContext` and returns exactly
 * what it did before; DF1 only READS the outcome to emit a trigger marker, feed
 * the ambient collector, and back the three report commands. The projection
 * mechanism itself is untouched.
 */
export function installDeterministicCompaction(
	pi: ExtensionAPI,
	config: DeterministicCompactionConfig,
	options: InstallOptions = {},
): InstalledHandle {
	const observabilityState: ObservabilityState = { config, turnCounter: 0 };

	// --- DF2 tuning state -------------------------------------------------------
	// A typed, mutable view over the SAME `config` object observabilityState holds,
	// plus the on/off master switch. The seam-A hook below reads `tuning.isEnabled()`
	// and the config fields live each turn, so a `/compaction set|on|off` takes
	// effect on the very next `context` firing (and DF1's reports stay consistent).
	const tuning = new TuningState(config);
	const tuningTelemetry: TuningTelemetry = {
		write: options.tuning?.write,
		writeOptions: options.tuning?.writeOptions,
		schemaFamily: AMBIENT_SCHEMA_FAMILY,
		schemaVersion: AMBIENT_SCHEMA_VERSION,
	};

	// --- Ambient telemetry state ------------------------------------------------
	const telemetry = new AmbientCollector();
	let telemetryEnabled = !(options.telemetry?.disabled ?? false);
	const writeRow = options.telemetry?.write ?? appendAmbientRow;
	const writeOpts = options.telemetry?.writeOptions;

	// The ambient summary is CUMULATIVE (the collector accumulates over the whole
	// session), and is APPENDED — never truncated — so it coexists with DF2's
	// future tuning rows in the same per-session file. Each flush writes the
	// session-so-far roll-up; the LAST `type:"session"` row for a session_id is the
	// authoritative complete-session summary (the tolerant G1c reader takes the
	// final roll-up, exactly as metrics.ts models a stream of rows).
	//
	// Flush points:
	//   - agent_end: the natural boundary where a prompt's work completes. Fires
	//     once per user prompt (post steering-fix), so a one-prompt session writes
	//     exactly one row.
	//   - session_shutdown: teardown (quit/reload/switch). Writes only if no
	//     agent_end ever flushed (a session torn down before completing a loop but
	//     with data), so the common path is not duplicated.
	let anyFlush = false;
	const flushTelemetry = (sessionId: string): string | undefined => {
		if (!telemetryEnabled || !telemetry.hasData()) return undefined;
		try {
			const path = writeRow(telemetry.buildRow(sessionId), writeOpts);
			anyFlush = true;
			return path;
		} catch {
			// Telemetry is best-effort observability; never let a write failure
			// break the session. (Local disk only — no network path exists here.)
			return undefined;
		}
	};

	// ---- live gate line: register the widget once ---------------------------
	//
	// The gate widget is a one-line strip rendered between the scrollable chat
	// area and the editor. A module-level flag ensures it is registered on the
	// very first context event that runs inside interactive TUI mode.

	// Seam A — send-time projection on every LLM call.
	pi.on("context", (event, ctx) => {
		observabilityState.turnCounter += 1;
		const turn = observabilityState.turnCounter;

		// Register the gate widget on first TUI-capable context event.
		if (typeof ctx.ui.setWidget === "function") {
			registerGateWidget(ctx.ui);
		}

		// DF2 negative-zone escape hatch: `/compaction off` disables seam-A entirely
		// for this session. Pass messages through UNCHANGED — byte-identical to never
		// having installed the hook — but still tally ambient telemetry (raw tokens,
		// not projected) so the record reflects that this turn was NOT compacted.
		if (!tuning.isEnabled()) {
			if (telemetryEnabled) {
				const rawTokens = estimateAgentTokens(event.messages as AgentMessage[]);
				telemetry.onTurn(rawTokens, false, []);
			}
			// Update gate: tuning off → show raw tokens + "off" label.
			gateStatus.rawTokens = estimateAgentTokens(event.messages as AgentMessage[]);
			gateStatus.threshold = config.compactAfterInputTokens;
			gateStatus.triggerState = "off";
			return;
		}

		const outcome = projectContext(event.messages as AgentMessage[], config);

		// Update gate status from projection outcome.
		gateStatus.rawTokens = outcome.rawTokens;
		gateStatus.threshold = config.compactAfterInputTokens;
		gateStatus.triggerState = outcome.projected ? "active" : "waiting";

		// Track last projection savings (null until the first real trigger).
		if (outcome.projected && outcome.compaction) {
			gateStatus.lastSavedTokens = outcome.compaction.tokensSaved;
			gateStatus.lastSavedPct =
				outcome.rawTokens > 0
					? Math.round((outcome.compaction.tokensSaved / outcome.rawTokens) * 100)
					: 0;
		}

		// Ambient: record the OUTGOING payload's estimated tokens (post-projection
		// when projected, raw otherwise) and whether we projected this turn.
		if (telemetryEnabled) {
			const sentTokens = outcome.projected
				? estimateAgentTokens(outcome.messages)
				: outcome.rawTokens;
			telemetry.onTurn(sentTokens, outcome.projected, compactedReadPaths(outcome));
		}

		if (!outcome.projected) {
			// Identity: return undefined so pi keeps the original messages and the
			// prompt prefix stays byte-stable for provider caching.
			return;
		}

		// Observability: a projection ACTUALLY fired this turn — make it visible via
		// a custom ENTRY (never a mid-stream sendMessage, which would steer the agent).
		if (options.observability !== false && typeof (pi as { appendEntry?: unknown }).appendEntry === "function") {
			emitTriggerMarker(pi, {
				turn,
				compactedCount: outcome.compaction?.compactedCount ?? 0,
				effectiveTokensSaved: outcome.compaction?.tokensSaved ?? 0,
				rawTokens: outcome.rawTokens,
				compactAfterInputTokens: config.compactAfterInputTokens,
			});
		}

		return { messages: outcome.messages };
	});

	// Ambient: tally each assistant response (output tokens, cache, re-reads).
	if (telemetryEnabled) {
		pi.on("message_end", (event) => {
			const msg = event.message as AgentMessage;
			if ((msg as { role?: string }).role === "assistant") {
				// A pi AssistantMessage structurally satisfies AmbientCollector's
				// AssistantLike (role/content/usage); the collector only reads those.
				telemetry.recordAssistant(msg as unknown as AssistantLike);
			}
		});
	}

	// Ambient: flush at the prompt-completion boundary, and as a fallback at
	// teardown for sessions that never completed a loop (see flushTelemetry doc).
	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		flushTelemetry(ctx.sessionManager.getSessionId());
	});
	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		if (!anyFlush) flushTelemetry(ctx.sessionManager.getSessionId());
	});

	// --- Observability commands + trigger-marker renderer -----------------------
	// Guarded on capability presence: the real ExtensionAPI always has these, but
	// a partially-mocked `pi` (e.g. a unit test that stubs only `on`) may not.
	// Registration is a best-effort no-op there — the projection/telemetry wiring
	// above does not depend on it.
	const canRegisterCommands = typeof (pi as { registerCommand?: unknown }).registerCommand === "function";
	const canRegisterMsgRenderer = typeof (pi as { registerMessageRenderer?: unknown }).registerMessageRenderer === "function";
		const canRegisterEntryRenderer = typeof (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer === "function";
	if (options.observability !== false && canRegisterCommands) {
		registerObservabilityCommands(pi, observabilityState);
		// Report output = custom MESSAGE (idle, safe) -> MessageRenderer.
		if (canRegisterMsgRenderer) {
			pi.registerMessageRenderer(OBSERVABILITY_MESSAGE_TYPE, makeReportRenderer({ Box, Text }));
		}
		// Trigger marker = custom ENTRY (mid-stream, no steer) -> EntryRenderer.
		if (canRegisterEntryRenderer) {
			pi.registerEntryRenderer(OBSERVABILITY_TRIGGER_TYPE, makeTriggerRenderer({ Box, Text }));
		}

		// The single `/compaction` command. DF1 owns `telemetry on|off`; DF2 adds
		// `on|off` (seam-A master switch) and `set keep-recent=N` / `set compact-after=N`.
		// Parsing order is deliberate: DF1's `telemetry …` is matched FIRST by exact
		// string, THEN we hand off to parseTuningCommand (which only ever accepts bare
		// `on`/`off`/`set …`), so `/compaction off` (seam-A) and `/compaction telemetry
		// off` (telemetry) can never be confused in either direction.
		pi.registerCommand("compaction", {
			description: "Compaction controls: on|off, set keep-recent=N, set compact-after=N, telemetry on|off",
			getArgumentCompletions: (prefix: string) => {
				const opts = ["telemetry off", "telemetry on", ...TUNING_COMPLETIONS];
				const hits = opts.filter((o) => o.startsWith(prefix));
				return hits.length > 0 ? hits.map((o) => ({ value: o, label: o })) : null;
			},
			handler: async (args, ctx) => {
				const arg = args.trim().toLowerCase();

				// --- DF1: ambient telemetry toggle (exact match, checked first). ---
				if (arg === "telemetry off") {
					telemetryEnabled = false;
					ctx.ui.notify("Ambient telemetry disabled for this session.", "info");
					return;
				}
				if (arg === "telemetry on") {
					telemetryEnabled = true;
					ctx.ui.notify("Ambient telemetry enabled for this session.", "info");
					return;
				}

				// --- DF2: seam-A on/off + set keep-recent / compact-after. ---
				const parsed = parseTuningCommand(arg);
				if (parsed === null) {
					ctx.ui.notify(
						"Usage: /compaction on | off | set keep-recent=N | set compact-after=N | telemetry on|off",
						"warning",
					);
					return;
				}
				if (parsed.kind === "set-error") {
					ctx.ui.notify(parsed.message, "warning");
					return;
				}

				const sessionId = ctx.sessionManager.getSessionId();

				if (parsed.kind === "toggle") {
					const old = tuning.isEnabled();
					const changed = tuning.setEnabled(parsed.enabled);
					if (!changed) {
						ctx.ui.notify(`Compaction already ${parsed.enabled ? "on" : "off"}.`, "info");
						return;
					}
					// Estimate context tokens at the moment of the change (same estimator
					// as the seam-A gate) and record exactly one tuning row.
					const ctxTokens = estimateContextTokensNow(ctx);
					recordTuningEvent(sessionId, "enabled", old, parsed.enabled, ctxTokens, tuningTelemetry);
					maybePersist(tuning, options.tuning, ctx);
					ctx.ui.notify(
						parsed.enabled
							? "Compaction ON — seam-A projection active next turn."
							: "Compaction OFF — messages pass through unprojected next turn.",
						"info",
					);
					return;
				}

				// parsed.kind === "set"
				const old = parsed.target === "keep-recent" ? tuning.getKeepRecent() : tuning.getCompactAfter();
				const changed =
					parsed.target === "keep-recent" ? tuning.setKeepRecent(parsed.value) : tuning.setCompactAfter(parsed.value);
				if (!changed) {
					ctx.ui.notify(`${parsed.target} already ${parsed.value}; no change.`, "info");
					return;
				}
				const ctxTokens = estimateContextTokensNow(ctx);
				recordTuningEvent(sessionId, parsed.target, old, parsed.value, ctxTokens, tuningTelemetry);
				maybePersist(tuning, options.tuning, ctx);
				// F-A label: the set value and the context readout are DIFFERENT
				// scales — compact-after is a compactable-content token gate, while
				// ctxTokens is the total context estimate (~100x larger). Tag each
				// so tuning can't conflate them. Semantics unchanged; label only.
				const gateUnit =
					parsed.target === "compact-after" ? "compactable-content tokens" : "recent assistant msgs";
				ctx.ui.notify(
					`${parsed.target} ${old} -> ${parsed.value} ${gateUnit} (takes effect next turn). Context now ~${
						ctxTokens?.toLocaleString() ?? "?"
					} total tokens.`,
					"info",
				);
			},
		});
	}

	// Seam B — deterministic self-contained checkpoint, OFF unless enabled.
	if (config.seamBEnabled) {
		pi.on("session_before_compact", async (event, _ctx: ExtensionContext) => {
			const input: SeamBInput = {
				messagesToSummarize: event.preparation.messagesToSummarize as AgentMessage[],
				turnPrefixMessages: event.preparation.turnPrefixMessages as AgentMessage[],
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				previousSummary: event.preparation.previousSummary,
				compactionOptions: config.compactionOptions,
			};
			return { compaction: buildSeamBCheckpoint(input) };
		});
	}

	return {
		observabilityState,
		telemetry,
		isTelemetryEnabled: () => telemetryEnabled,
		flushTelemetry,
		tuning,
	};
}

/**
 * Best-effort settings persistence for a tuning change. No-op unless
 * `options.tuning.persist` is true (persistence is opt-in — it touches a real
 * `.pi/settings.json` and is not read back by this extension). Resolves the
 * project cwd from the command context. Never throws into the command path.
 */
function maybePersist(tuning: TuningState, tuningOpts: InstallOptions["tuning"], ctx: ExtensionContext): void {
	if (!tuningOpts?.persist) return;
	const cwd = ctx.sessionManager.getCwd();
	if (!cwd) return;
	const persistOpts: PersistOptions = { cwd, configDirName: tuningOpts.configDirName };
	persistTuning(tuning, persistOpts);
}

const factory = (pi: ExtensionAPI): void => {
	installDeterministicCompaction(pi, resolveConfig());
};

export default factory;

/**
 * Metrics collection + JSONL row schema for one arm-run.
 *
 * One run emits a JSONL file: a header `type:"meta"` row, one `type:"turn"` row
 * per LLM call, and a final `type:"summary"` row (row shape mirrors taucode's
 * dogfood-p0 tolerant reader — every numeric field is a plain top-level number so
 * compare.ts can read it without knowing the producer). No conclusions are drawn
 * here; this module only counts and records.
 *
 * ---------------------------------------------------------------------------
 * MEASUREMENT TAP POINTS
 * ---------------------------------------------------------------------------
 * The `context` hook is the single input-side tap: pi fires it on EVERY LLM call
 * with the exact outgoing `messages` payload (after any compaction projection),
 * before the payload reaches the provider. So per-turn INPUT tokens are measured
 * there via pi's own `estimateContextTokens` (reused, never re-invented), and the
 * observer also sees whether the payload was compacted. The mock/real provider's
 * response usage is the output-side tap: OUTPUT tokens come from `usage.output`
 * when present (else an estimate of the assistant text), and cacheRead comes from
 * `usage.cacheRead` (g0-survey Item 5: DeepSeek's `prompt_cache_hit_tokens` maps
 * here). The on-disk session JSONL is the ground-truth transcript used for
 * tool-call / re-read counting.
 *
 * ---------------------------------------------------------------------------
 * FORMULAS (documented precisely, applied consistently)
 * ---------------------------------------------------------------------------
 * re_read_count
 *   A `read` tool call whose target path was ALREADY the target of an earlier
 *   `read` in the same run. First read of a path is not a re-read; every later
 *   read of that same path counts +1. Path identity is the exact `path` argument
 *   string (no normalisation) — matches how the extension resolves read paths
 *   from toolCall args (adapter.ts correction #1).
 *
 * compacted_paths
 *   The set of paths whose `read` RESULT was actually compacted (summarised) by
 *   the seam-A hook at least once during the run. A path enters this set the turn
 *   its read result is projected away; it is a property of the run, not of a
 *   single turn.
 *
 * compacted_path_re_reads
 *   Count of `read` tool calls, at ANY later turn, whose target path is in
 *   `compacted_paths`. (A read of a compacted path is counted whether or not that
 *   specific read is itself later a "re-read" — the concern is touching a path the
 *   agent had already been told was summarised.)
 *
 * compacted_path_re_read_rate  ← THE metric that would have caught taucode's
 *   documented false-savings case (aggressive settings: tokens down 47% while
 *   re-reads shot to 124). Defined as:
 *
 *       compacted_path_re_read_rate = compacted_path_re_reads / total_read_calls
 *
 *   i.e. the fraction of ALL read calls in the run that targeted an
 *   already-compacted path. Denominator is total reads (not total re-reads, not
 *   |compacted_paths|) because that is the stable, always-defined base and makes
 *   the rate directly comparable across arms with different read volumes. When
 *   there are zero read calls the rate is `null` (undefined, not 0).
 *
 * ---------------------------------------------------------------------------
 * CACHE NULL-vs-0 (g0-survey Item 5)
 * ---------------------------------------------------------------------------
 * `usage.cacheRead` is recorded verbatim when the provider populates it. A mock
 * provider that emits no cache signal yields `cache_read_tokens: null` — NOT 0.
 * `null` = "no signal available"; `0` = "confirmed zero cache hits". They are
 * kept distinct so the eventual real-provider analysis is not corrupted.
 */

import { createHash } from "node:crypto";
import type { AssistantMessage, ToolCall as PiToolCall, Usage } from "@earendil-works/pi-ai";
import type { SummaryRecord, TailEvidence, TailEvidenceBlock } from "./compaction-core-adapter.js";

/** Header row: run identity + config, emitted once at the top of the file. */
export interface MetaRow {
	type: "meta";
	schema_version: number;
	arm: string;
	arm_label: string;
	scenario: string;
	provider: string;
	/** Whether the mechanism this arm relies on was OBSERVED to engage. */
	mechanism: {
		/** Native pi compaction enabled for this arm. */
		native_compaction_enabled: boolean;
		/** G1b seam-A context hook installed for this arm. */
		seam_a_installed: boolean;
		/** G1b seam-B checkpoint installed for this arm. */
		seam_b_installed: boolean;
		compact_after_input_tokens: number | null;
		keep_recent_assistant_messages: number | null;
		/** Optional B-fixed preflight override for provider model context window. */
		provider_context_window?: number | null;
		/** Optional V3-WS harness wiring: file-exists acceptance targets. */
		anchor_acceptance_targets?: string | null;
		/** EXP-WS addon flags layered onto a physical A/B/C/D arm. */
		extension_flags?: {
			semantic_anchor: boolean;
			ws_declaration: boolean;
			sideband_summary: boolean;
			ws_policy: boolean;
			placebo_token_matching: boolean;
			compact_nudge_tail: boolean;
		};
		/** Token target for the C+PL placebo tail, null outside placebo arms. */
		placebo_tail_target_tokens?: number | null;
		/** WS-2.5 measurement nudge mode; must stay off in ordinary experiment arms. */
		ws_declare_nudge?: "off" | "every-turn";
		/** G4c: frontier-pruning's own `context` hook installed (TRC, arm T). */
		trc_installed?: boolean;
		/** TRC config in effect when trc_installed; absent/null when TRC is not installed. */
		trc_config?: {
			trigger_tokens: number;
			keep: number;
			clear_at_least: number | null;
			exclude_tools: string[] | null;
			clear_tool_inputs: boolean | string[];
			preserve_error_results: boolean;
		} | null;
	};
	started_at: string;
	/** Marker string so smoke fixtures are never mistaken for real G2 workloads. */
	data_kind: string;
	/**
	 * Provenance of the run's workspace. Present only when the run was seeded from
	 * a prepared snapshot via `--workspace-from` (G1d): records exactly which
	 * snapshot dir and content-manifest hash the workspace started from, so "all
	 * arms started byte-identical" is an auditable field, not just a promise.
	 * Absent for the default fresh-tmpdir + seedFiles path.
	 */
	workspace?: { source: string; manifestHash: string | null };
}

/** One LLM call. Numeric fields are top-level for the tolerant reader. */
export interface TurnRow {
	type: "turn";
	turn: number;
	/** Estimated tokens of the OUTGOING payload (pi estimateContextTokens). */
	input_tokens: number;
	/** OUTPUT tokens from provider usage, else estimated from assistant text. */
	output_tokens: number;
	/** true when output_tokens came from provider usage, false when estimated. */
	output_from_usage: boolean;
	/** Provider reasoning tokens for this turn, or null when not reported. */
	reasoning_tokens: number | null;
	/** Tool calls issued in THIS turn's assistant message. */
	tool_calls: number;
	/** `read` tool calls in this turn. */
	read_calls: number;
	/** read calls this turn targeting a path already read earlier in the run. */
	re_reads: number;
	/** read calls this turn targeting a path already compacted earlier. */
	compacted_path_re_reads: number;
	/**
	 * read calls this turn targeting a path already cleared by TRC earlier
	 * (G4c — isomorphic to compacted_path_re_reads, same entry point for the
	 * FP-1 (a) detector, semantics kept side-by-side, never merged into it).
	 */
	cleared_path_re_reads: number;
	/**
	 * G4c: TRC's (frontier-pruning) per-turn projection report, re-derived by
	 * the observer the same way seam-A's input_tokens/projected are derived —
	 * never null's sibling fields half-populated. `null` when TRC is not
	 * installed for this arm. `clearedInputTokensEst` is the ESTIMATOR's unit
	 * (chars/4, R3), not a real provider token count.
	 */
	trc: {
		applied: boolean;
		clearedToolUses: number;
		clearedInputTokensEst: number;
		gateReading: number;
	} | null;
	/** Whether seam-A projected (compacted) THIS turn's outgoing payload. */
	projected: boolean;
	/** cacheRead tokens for this turn, or null when the provider gave no signal. */
	cache_read_tokens: number | null;
	/** OBS-TAIL: projected-turn tail evidence, empty when no tail block was injected. */
	tail_blocks: TailEvidenceBlock[];
	/** OBS-TAIL: count of anchor lines injected on this projected turn. */
	anchor_lines: number;
	/** OBS-TAIL: hash of anchor block content, null when no anchor was injected. */
	anchor_hash: string | null;
	/** Placeholder for later human fill-in (never computed). */
	completion: string;
}

/** Final roll-up. Mirrors the fields dogfood-p0's summarizer looks for. */
export interface SummaryRow {
	type: "summary";
	arm: string;
	arm_label: string;
	scenario: string;
	provider: string;
	session_id: string;
	workspace: string;
	turn_count: number;
	total_input_tokens: number;
	total_output_tokens: number;
	total_tool_calls: number;
	total_read_calls: number;
	/** Re-read count (see formula above). */
	total_re_reads: number;
	/** Number of distinct paths whose read result was compacted at least once. */
	compacted_path_count: number;
	/** Reads targeting an already-compacted path (see formula). */
	total_compacted_path_re_reads: number;
	/** compacted_path_re_reads / total_read_calls, or null when no reads. */
	compacted_path_re_read_rate: number | null;
	/** G4c: number of distinct paths TRC cleared at least once (isomorphic to compacted_path_count). */
	cleared_path_count: number;
	/** G4c: reads targeting an already-TRC-cleared path (isomorphic to total_compacted_path_re_reads). */
	total_cleared_path_re_reads: number;
	/** Turns on which seam-A projected the payload. */
	projected_turn_count: number;
	/** Whether native pi compaction actually fired (arm A/B signal). */
	native_compactions_observed: number;
	/** Native summariser provider calls (arm B); 0 when it never ran. */
	summarizer_calls: number;
	/** Summariser input tokens included in total_input_tokens. */
	summarizer_input_tokens: number;
	/** Summariser output tokens included in total_output_tokens. */
	summarizer_output_tokens: number;
	/** Sideband summariser provider calls (C-SB); 0 when it never ran. */
	sideband_calls: number;
	/** Sideband input tokens included in total_input_tokens. */
	sideband_input_tokens: number;
	/** Sideband output tokens included in total_output_tokens. */
	sideband_output_tokens: number;
	/** Total cacheRead across turns; null when NO turn had a signal. */
	total_cache_read_tokens: number | null;
	/** Total reasoning tokens across turns; null when NO turn had a signal. */
	total_reasoning_tokens: number | null;
	/** Whether ANY turn carried a cacheRead signal (drives null-vs-0). */
	cache_signal_present: boolean;
	completion: string;
	data_kind: string;
}

export interface SidebandRow {
	type: "sideband";
	turn: number;
	path: string;
	hash: string;
	record_id: string;
	model: string;
	input_tokens: number;
	output_tokens: number;
	text_hash: string;
	source_hashes: string[];
}

export type MetricRow = MetaRow | TurnRow | SidebandRow | SummaryRow;

// --- message helpers -------------------------------------------------------

function assistantText(m: AssistantMessage): string {
	let s = "";
	for (const b of m.content) if (b.type === "text") s += b.text;
	return s;
}

function reasoningFromUsage(usage: Usage | undefined): number | null {
	if (!usage) return null;
	const raw = usage as Usage & { reasoning?: unknown; reasoningTokens?: unknown };
	if (typeof raw.reasoning === "number" && Number.isFinite(raw.reasoning)) return raw.reasoning;
	if (typeof raw.reasoningTokens === "number" && Number.isFinite(raw.reasoningTokens)) return raw.reasoningTokens;
	return null;
}

/** read-tool calls (with their path arg) in an assistant message, in order. */
function readCallsIn(m: AssistantMessage): { id: string; path: string | undefined }[] {
	const out: { id: string; path: string | undefined }[] = [];
	for (const b of m.content) {
		if (b.type !== "toolCall") continue;
		const tc = b as PiToolCall;
		if (tc.name !== "read") continue;
		const path = typeof tc.arguments?.path === "string" ? (tc.arguments.path as string) : undefined;
		out.push({ id: tc.id, path });
	}
	return out;
}

function toolCallCount(m: AssistantMessage): number {
	let n = 0;
	for (const b of m.content) if (b.type === "toolCall") n++;
	return n;
}

// --- the collector ---------------------------------------------------------

/**
 * Accumulates run state across turns. `onOutgoingTokens` is called from the
 * observer context hook with the content-based token estimate of the exact
 * payload pi will send; `noteProjected` flags a compacting turn and records which
 * read paths were compacted; `recordAssistant` is called with each assistant
 * response (for output/usage and to advance re-read tracking on the calls the
 * model just issued).
 */
export class RunMetrics {
	private turns: TurnRow[] = [];
	private seenReadPaths = new Set<string>();
	private compactedPaths = new Set<string>();
	private clearedPaths = new Set<string>();
	private totalReadCalls = 0;
	private totalReReads = 0;
	private totalCompactedPathReReads = 0;
	private totalClearedPathReReads = 0;
	private cacheSignalPresent = false;
	private cacheTotal = 0;
	private reasoningSignalPresent = false;
	private reasoningTotal = 0;
	private nativeCompactions = 0;
	// Summariser accounting (arm B): the native compactor's OWN provider call.
	private summarizerInputTokens = 0;
	private summarizerOutputTokens = 0;
	private summarizerCalls = 0;
	private sidebandRows: SidebandRow[] = [];
	private sidebandInputTokens = 0;
	private sidebandOutputTokens = 0;

	// per-turn scratch, set by onOutgoingTokens, consumed by recordAssistant.
	private pendingInputTokens = 0;
	private pendingProjected = false;
	private pendingTrc: TurnRow["trc"] = null;
	private tailEvidenceByTurn = new Map<number, TailEvidence>();

	/**
	 * Record the input-token estimate for the payload that will ACTUALLY be sent
	 * this turn. Callers pass the content-based estimate (estimatePayloadTokens,
	 * which reuses pi's per-message estimateTokens) of the SENT payload — for a
	 * seam-A arm that is the post-projection (compacted) payload; for arms with no
	 * hook it is the raw payload.
	 */
	onOutgoingTokens(sentInputTokens: number): void {
		this.pendingInputTokens = sentInputTokens;
	}

	/**
	 * Flag that seam-A projected this turn, and register the paths whose read
	 * RESULT was compacted (so later reads of them count as compacted-path reads).
	 */
		noteProjected(compactedReadPaths: string[]): void {
			this.pendingProjected = true;
			for (const p of compactedReadPaths) this.compactedPaths.add(p);
		}

		/**
		 * G4c isomorphic sibling of noteProjected, for TRC (arm T). Called EVERY
		 * turn TRC's hook is installed (not just when it actually clears — the
		 * report's own `applied` flag carries that), so `trc` is populated
		 * (never left half-null) for every turn on this arm. Registers only the
		 * "path-alive" cleared paths (clearToolInputs did not also wipe the path
		 * argument) into the re-read-tracking set: a path whose identity is no
		 * longer observable in the transcript is a structurally different,
		 * stronger failure mode than "content cleared but path still visible" —
		 * conflating the two would corrupt the compacted-path isomorphism this
		 * counter mirrors.
		 */
		noteTrc(report: NonNullable<TurnRow["trc"]>, clearedAlivePaths: string[]): void {
			this.pendingTrc = report;
			if (report.applied) this.pendingProjected = true;
			for (const p of clearedAlivePaths) this.clearedPaths.add(p);
		}

		noteTailEvidence(evidence: TailEvidence): void {
			this.tailEvidenceByTurn.set(evidence.turn, evidence);
		}

	/** Native pi compaction fired (observed via session events). */
	noteNativeCompaction(): void {
		this.nativeCompactions++;
	}

	/**
	 * Record the native summariser's OWN token cost (arm B). pi issues an extra
	 * provider call to summarise; its input+output tokens are part of arm B's cost
	 * and are added into the run totals so arm B is not undercounted.
	 */
	recordSummarizer(calls: number, inputTokens: number, outputTokens: number): void {
		this.summarizerCalls = calls;
		this.summarizerInputTokens = inputTokens;
		this.summarizerOutputTokens = outputTokens;
	}

	recordSideband(record: SummaryRecord): void {
		const cost = record.providerCost;
		if (!cost) return;
		this.sidebandRows.push({
			type: "sideband",
			turn: record.turn,
			path: record.path,
			hash: record.hash,
			record_id: record.id,
			model: cost.model,
			input_tokens: cost.inputTokens,
			output_tokens: cost.outputTokens,
			text_hash: createHash("sha256").update(record.text).digest("hex").slice(0, 16),
			source_hashes: record.sourceHashes,
		});
		this.sidebandInputTokens += cost.inputTokens;
		this.sidebandOutputTokens += cost.outputTokens;
	}

	/**
	 * Record the assistant message for turn N. Advances re-read / compacted-path
	 * tracking using the read calls the model issued in THIS message.
	 */
	recordAssistant(turnNumber: number, message: AssistantMessage): void {
		const reads = readCallsIn(message);
		let turnReReads = 0;
		let turnCompactedPathReReads = 0;
		let turnClearedPathReReads = 0;
		for (const r of reads) {
			this.totalReadCalls++;
			const key = r.path ?? "<unknown>";
			if (this.compactedPaths.has(key)) {
				turnCompactedPathReReads++;
				this.totalCompactedPathReReads++;
			}
			if (this.clearedPaths.has(key)) {
				turnClearedPathReReads++;
				this.totalClearedPathReReads++;
			}
			if (this.seenReadPaths.has(key)) {
				turnReReads++;
				this.totalReReads++;
			} else {
				this.seenReadPaths.add(key);
			}
		}

		const usage: Usage | undefined = "usage" in message ? (message.usage as Usage) : undefined;
		const hasOutputUsage = !!usage && typeof usage.output === "number" && usage.output > 0;
		const outputTokens = hasOutputUsage
			? usage!.output
			: Math.ceil(assistantText(message).length / 4);
		const reasoningTokens = reasoningFromUsage(usage);
		if (reasoningTokens !== null) {
			this.reasoningSignalPresent = true;
			this.reasoningTotal += reasoningTokens;
		}

		const tailEvidence = this.tailEvidenceByTurn.get(turnNumber);
		// cacheRead: record verbatim when the provider gave a signal, else null.
		// A mock provider populates usage but with cacheRead 0 AND no real cache;
		// we treat cacheRead as "signal present" only when the field is a finite
		// number AND the provider is one that reports caching. To stay honest for
		// the mock, callers pass cacheSignal=false via recordCache below; the
		// per-turn value here defaults to null unless recordCache says otherwise.
		this.turns.push({
			type: "turn",
			turn: turnNumber,
			input_tokens: this.pendingInputTokens,
			output_tokens: outputTokens,
			output_from_usage: hasOutputUsage,
			reasoning_tokens: reasoningTokens,
			tool_calls: toolCallCount(message),
			read_calls: reads.length,
			re_reads: turnReReads,
			compacted_path_re_reads: turnCompactedPathReReads,
			cleared_path_re_reads: turnClearedPathReReads,
			trc: this.pendingTrc,
			projected: this.pendingProjected,
			cache_read_tokens: null,
			tail_blocks: tailEvidence?.tail_blocks ?? [],
			anchor_lines: tailEvidence?.anchor_lines ?? 0,
			anchor_hash: tailEvidence?.anchor_hash ?? null,
			completion: "",
		});
		this.tailEvidenceByTurn.delete(turnNumber);
		// reset per-turn scratch.
		this.pendingInputTokens = 0;
		this.pendingProjected = false;
		this.pendingTrc = null;
	}

	/**
	 * Attach a cache-read signal to the most recent turn. `signalPresent=false`
	 * (the mock default) keeps `cache_read_tokens: null`; when a real provider
	 * reports caching, callers pass the `usage.cacheRead` value and true.
	 */
	recordCache(value: number | null, signalPresent: boolean): void {
		const last = this.turns[this.turns.length - 1];
		if (!last) return;
		if (signalPresent && typeof value === "number") {
			last.cache_read_tokens = value;
			this.cacheSignalPresent = true;
			this.cacheTotal += value;
		} else {
			last.cache_read_tokens = null;
		}
	}

	getTurns(): TurnRow[] {
		return this.turns;
	}

	getSidebandRows(): SidebandRow[] {
		return this.sidebandRows;
	}

	buildSummary(base: {
		arm: string;
		arm_label: string;
		scenario: string;
		provider: string;
		session_id: string;
		workspace: string;
		/** Marker for the run's data provenance. Defaults to the smoke marker. */
		data_kind?: string;
	}): SummaryRow {
		// Totals INCLUDE the native summariser's own tokens (arm B): pi's auto-
		// compaction call is a real provider round-trip whose cost belongs to the arm.
		const totalInput = this.turns.reduce((a, t) => a + t.input_tokens, 0) + this.summarizerInputTokens + this.sidebandInputTokens;
		const totalOutput = this.turns.reduce((a, t) => a + t.output_tokens, 0) + this.summarizerOutputTokens + this.sidebandOutputTokens;
		const totalTools = this.turns.reduce((a, t) => a + t.tool_calls, 0);
		const projectedTurns = this.turns.reduce((a, t) => a + (t.projected ? 1 : 0), 0);
		const rate = this.totalReadCalls > 0 ? this.totalCompactedPathReReads / this.totalReadCalls : null;
		return {
			type: "summary",
			arm: base.arm,
			arm_label: base.arm_label,
			scenario: base.scenario,
			provider: base.provider,
			session_id: base.session_id,
			workspace: base.workspace,
			turn_count: this.turns.length,
			total_input_tokens: totalInput,
			total_output_tokens: totalOutput,
			total_tool_calls: totalTools,
			total_read_calls: this.totalReadCalls,
			total_re_reads: this.totalReReads,
			compacted_path_count: this.compactedPaths.size,
			total_compacted_path_re_reads: this.totalCompactedPathReReads,
			compacted_path_re_read_rate: rate,
			cleared_path_count: this.clearedPaths.size,
			total_cleared_path_re_reads: this.totalClearedPathReReads,
			projected_turn_count: projectedTurns,
			native_compactions_observed: this.nativeCompactions,
			summarizer_calls: this.summarizerCalls,
			summarizer_input_tokens: this.summarizerInputTokens,
			summarizer_output_tokens: this.summarizerOutputTokens,
			sideband_calls: this.sidebandRows.length,
			sideband_input_tokens: this.sidebandInputTokens,
			sideband_output_tokens: this.sidebandOutputTokens,
			total_cache_read_tokens: this.cacheSignalPresent ? this.cacheTotal : null,
			total_reasoning_tokens: this.reasoningSignalPresent ? this.reasoningTotal : null,
			cache_signal_present: this.cacheSignalPresent,
			completion: "",
			data_kind: base.data_kind ?? "synthetic-smoke-fixture",
		};
	}
}

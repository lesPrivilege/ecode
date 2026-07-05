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

import type { AssistantMessage, ToolCall as PiToolCall, Usage } from "@earendil-works/pi-ai";

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
	};
	started_at: string;
	/** Marker string so smoke fixtures are never mistaken for real G2 workloads. */
	data_kind: "synthetic-smoke-fixture";
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
	/** Tool calls issued in THIS turn's assistant message. */
	tool_calls: number;
	/** `read` tool calls in this turn. */
	read_calls: number;
	/** read calls this turn targeting a path already read earlier in the run. */
	re_reads: number;
	/** read calls this turn targeting a path already compacted earlier. */
	compacted_path_re_reads: number;
	/** Whether seam-A projected (compacted) THIS turn's outgoing payload. */
	projected: boolean;
	/** cacheRead tokens for this turn, or null when the provider gave no signal. */
	cache_read_tokens: number | null;
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
	/** Total cacheRead across turns; null when NO turn had a signal. */
	total_cache_read_tokens: number | null;
	/** Whether ANY turn carried a cacheRead signal (drives null-vs-0). */
	cache_signal_present: boolean;
	completion: string;
	data_kind: "synthetic-smoke-fixture";
}

export type MetricRow = MetaRow | TurnRow | SummaryRow;

// --- message helpers -------------------------------------------------------

function assistantText(m: AssistantMessage): string {
	let s = "";
	for (const b of m.content) if (b.type === "text") s += b.text;
	return s;
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
	private totalReadCalls = 0;
	private totalReReads = 0;
	private totalCompactedPathReReads = 0;
	private cacheSignalPresent = false;
	private cacheTotal = 0;
	private nativeCompactions = 0;
	// Summariser accounting (arm B): the native compactor's OWN provider call.
	private summarizerInputTokens = 0;
	private summarizerOutputTokens = 0;
	private summarizerCalls = 0;

	// per-turn scratch, set by onOutgoingTokens, consumed by recordAssistant.
	private pendingInputTokens = 0;
	private pendingProjected = false;

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

	/**
	 * Record the assistant message for turn N. Advances re-read / compacted-path
	 * tracking using the read calls the model issued in THIS message.
	 */
	recordAssistant(turnNumber: number, message: AssistantMessage): void {
		const reads = readCallsIn(message);
		let turnReReads = 0;
		let turnCompactedPathReReads = 0;
		for (const r of reads) {
			this.totalReadCalls++;
			const key = r.path ?? "<unknown>";
			if (this.compactedPaths.has(key)) {
				turnCompactedPathReReads++;
				this.totalCompactedPathReReads++;
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
			tool_calls: toolCallCount(message),
			read_calls: reads.length,
			re_reads: turnReReads,
			compacted_path_re_reads: turnCompactedPathReReads,
			projected: this.pendingProjected,
			cache_read_tokens: null,
			completion: "",
		});
		// reset per-turn scratch.
		this.pendingInputTokens = 0;
		this.pendingProjected = false;
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

	buildSummary(base: {
		arm: string;
		arm_label: string;
		scenario: string;
		provider: string;
		session_id: string;
		workspace: string;
	}): SummaryRow {
		// Totals INCLUDE the native summariser's own tokens (arm B): pi's auto-
		// compaction call is a real provider round-trip whose cost belongs to the arm.
		const totalInput = this.turns.reduce((a, t) => a + t.input_tokens, 0) + this.summarizerInputTokens;
		const totalOutput = this.turns.reduce((a, t) => a + t.output_tokens, 0) + this.summarizerOutputTokens;
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
			projected_turn_count: projectedTurns,
			native_compactions_observed: this.nativeCompactions,
			summarizer_calls: this.summarizerCalls,
			summarizer_input_tokens: this.summarizerInputTokens,
			summarizer_output_tokens: this.summarizerOutputTokens,
			total_cache_read_tokens: this.cacheSignalPresent ? this.cacheTotal : null,
			cache_signal_present: this.cacheSignalPresent,
			completion: "",
			data_kind: "synthetic-smoke-fixture",
		};
	}
}

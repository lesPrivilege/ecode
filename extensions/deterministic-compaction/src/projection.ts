/**
 * Send-time projection for the `context` hook (seam A).
 *
 * The `context` hook (pi `AgentHarness.transformContext` -> `emitContext`) runs
 * before EVERY LLM call and only affects the outgoing send payload; its return
 * is never persisted (docs/g0-survey.md Item 3). Two properties matter here:
 *
 * 1. Idempotency. `compactCodeProductions` is idempotent by construction (an
 *    already-summarised tool call/result no longer exceeds the size thresholds,
 *    so a second pass is a no-op). We add no state of our own, so running the
 *    projection twice on the same messages yields the same output.
 *
 * 2. Bounded cost. The hook is hot. We reuse pi's own `estimateContextTokens`
 *    for the gate (correction #2 — no bespoke char-count estimator), do a single
 *    O(n) adapter pass, and only invoke compaction past the token threshold. The
 *    whole thing is O(n) in message count with no quadratic scans.
 *
 * Hybrid gating (preserve prefix cache): below `compactAfterInputTokens` the
 * messages are returned UNCHANGED (identity) so the provider prompt prefix is
 * byte-stable and cacheable. Only once the estimated context crosses the
 * threshold do we project — accepting a one-time cache break in exchange for a
 * smaller, cheaper context from then on.
 */

import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import {
	compactCodeProductions,
	pathLineCountExtractor,
	type CompactionInjection,
	type CompactionOptions,
	type CompactionResult,
} from "./compaction-core.js";
import { fromCore, toCore } from "./adapter.js";

export interface ProjectionConfig {
	/**
	 * Token threshold below which messages pass through unchanged (prefix-cache
	 * preservation). At or above it, deterministic compaction is applied.
	 */
	compactAfterInputTokens: number;
	/** compaction-core tuning (keepRecentAssistantMessages, minArgTokens, ...). */
	compactionOptions?: Partial<CompactionOptions>;
}

/**
 * Injection wired for pi: the read result has no hashline, so we use the
 * degraded `pathLineCountExtractor` (never emits a hash). Path resolution then
 * falls through to the paired read toolCall's `{path}` argument inside
 * `compactCodeProductions` (correction #1). Strategy set and tool-name matcher
 * stay at compaction-core defaults (pi's tool names — read/write/edit/bash —
 * already match exactly).
 */
export const PI_COMPACTION_INJECTION: CompactionInjection = {
	pathHashExtractor: pathLineCountExtractor,
};

/** Estimate context tokens using pi's own estimator (real usage when present). */
export function estimateAgentTokens(messages: AgentMessage[]): number {
	// estimateContextTokens accepts Message[]; AgentMessage[] may include custom
	// messages, but the estimator only reads role/content fields present on the
	// LLM shapes and treats others by their content, so passing the array is safe.
	return estimateContextTokens(messages as unknown as PiMessage[]).tokens;
}

export interface ProjectionOutcome {
	/** The messages to send (either identity or projected). */
	messages: AgentMessage[];
	/** True when the threshold was crossed and compaction actually ran. */
	projected: boolean;
	/** Token estimate that drove the gate. */
	rawTokens: number;
	/** compaction-core result when projected; undefined when gated out. */
	compaction?: CompactionResult;
}

/**
 * Apply hybrid-gated deterministic compaction to a pi transcript.
 *
 * Pure and side-effect free: does not mutate `messages`. Returns the original
 * array reference unchanged when gated out (identity), which keeps the send
 * payload byte-identical for prefix caching.
 */
export function projectContext(messages: AgentMessage[], config: ProjectionConfig): ProjectionOutcome {
	const rawTokens = estimateAgentTokens(messages);
	if (rawTokens < config.compactAfterInputTokens) {
		return { messages, projected: false, rawTokens };
	}

	const core = toCore(messages);
	const compaction = compactCodeProductions(core.coreMessages, config.compactionOptions, PI_COMPACTION_INJECTION);

	// If nothing was compacted, return identity to avoid a needless new array /
	// cache break (the projected messages would be byte-equal anyway).
	if (compaction.compactedCount === 0) {
		return { messages, projected: false, rawTokens, compaction };
	}

	const projectedMessages = fromCore(messages, core, compaction.messages);
	return { messages: projectedMessages, projected: true, rawTokens, compaction };
}

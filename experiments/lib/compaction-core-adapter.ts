/**
 * Thin re-export barrel bridging the experiments harness to G1b's finished,
 * verified deterministic-compaction package. Everything the harness needs from
 * G1b (the send-time projection, the token estimator, the seam-B checkpoint
 * builder, and the mock-provider helpers) is imported from
 * extensions/deterministic-compaction/src by RELATIVE PATH, exactly as G1b
 * itself imports compaction-core (the `./dist/index.js` packaging bug means
 * name-based resolution is unreliable; relative-source import is the established
 * workaround). The experiments code imports only from here so the repo layout is
 * known in one place.
 *
 * REUSE, don't rebuild: `projectContext` is the SAME function the seam-A hook
 * runs in production; the harness calls it to (a) know whether a turn's payload
 * would be compacted and (b) learn which read paths got summarised, for the
 * compacted-path-re-read metric. No compaction logic is duplicated here.
 */

export {
	projectContext,
	estimateAgentTokens,
	type ProjectionConfig,
	type ProjectionOutcome,
} from "../../extensions/deterministic-compaction/src/projection.js";

import { estimateTokens } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * CONTENT-based token estimate of an outgoing payload: the sum of pi's own
 * per-message `estimateTokens` (compaction.ts). Unlike `estimateContextTokens`
 * (which trusts the most-recent provider `usage` as a proxy for the prefix and is
 * therefore INsensitive to compaction of anything before that usage message),
 * this measures the payload's actual content size — so compacting a large read
 * result visibly reduces it. This is the honest "token-estimate the actual
 * payload sent" measure for the input metric; it reuses pi's estimator, not a
 * bespoke one. `estimateContextTokens` is still used as the seam-A GATE (that is
 * what G1b's hook gates on).
 */
export function estimatePayloadTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const m of messages) total += estimateTokens(m);
	return total;
}

export {
	installDeterministicCompaction,
	type DeterministicCompactionConfig,
} from "../../extensions/deterministic-compaction/src/extension.js";

export {
	createMockProvider,
	registerMockProvider,
	text,
	toolCall,
	type ScriptedStep,
	type ScriptedBlock,
	type MockProviderHandle,
	type MockProviderOptions,
} from "../../extensions/deterministic-compaction/src/mock-provider.js";

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
import type { CompactionOptions } from "./compaction-core.js";
import { projectContext, type ProjectionConfig } from "./projection.js";
import { buildSeamBCheckpoint, type SeamBInput } from "./seam-b.js";

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
 * Register the deterministic-compaction hooks on an ExtensionAPI.
 *
 * Exposed separately from the default export so tests can install the hooks on
 * a programmatically-created session with an explicit config, bypassing env.
 */
export function installDeterministicCompaction(pi: ExtensionAPI, config: DeterministicCompactionConfig): void {
	// Seam A — send-time projection on every LLM call.
	pi.on("context", (event) => {
		const outcome = projectContext(event.messages as AgentMessage[], config);
		if (!outcome.projected) {
			// Identity: return undefined so pi keeps the original messages and the
			// prompt prefix stays byte-stable for provider caching.
			return;
		}
		return { messages: outcome.messages };
	});

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
}

const factory = (pi: ExtensionAPI): void => {
	installDeterministicCompaction(pi, resolveConfig());
};

export default factory;

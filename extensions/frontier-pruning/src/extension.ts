/**
 * frontier-pruning — a pi extension (seam A only, `context` hook).
 *
 * On every LLM call, when ECODE_TRC=1, projects the outgoing send payload
 * through the clear_tool_uses_20250919 replica (@ecode/context-pruning).
 * Below the gate, or when nothing is eligible to clear, messages pass
 * through unchanged (prefix-cache preservation) — the hook return is a
 * send-time projection only and is never persisted
 * (docs/g0-survey.md Item 3; design R2).
 *
 * Configuration: seven env vars, design §4. All OFF / official defaults
 * until ECODE_TRC=1 is set.
 *
 * Loading: `pi --extension /abs/path/to/extensions/frontier-pruning/src/extension.ts`
 * (same jiti-source loading as deterministic-compaction). The default export
 * is the ExtensionFactory = (pi: ExtensionAPI) => void.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokensCharsDiv4 } from "./estimator.js";
import { type EnvLike, parseTrcFlags } from "./flags.js";
import { projectContext } from "./projection.js";

export interface ContextHookResult {
  messages: AgentMessage[];
}

/**
 * Builds the pure per-turn handler: flags are parsed once (env is stable
 * for a process's lifetime), producing a closure over `{enabled, config}`.
 */
export function createContextHookHandler(env: EnvLike = process.env): (messages: AgentMessage[]) => ContextHookResult {
  const { enabled, config } = parseTrcFlags(env);

  return function handleContext(messages: AgentMessage[]): ContextHookResult {
    if (!enabled) return { messages };
    const result = projectContext(messages, config, { estimateTokens: estimateTokensCharsDiv4 });
    return { messages: result.messages };
  };
}

export default function frontierPruningExtension(pi: ExtensionAPI, env: EnvLike = process.env): void {
  const handleContext = createContextHookHandler(env);
  pi.on("context", (event: { messages: AgentMessage[] }) => handleContext(event.messages));
}

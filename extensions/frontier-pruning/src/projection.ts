/**
 * pi AgentMessage[] <-> clearToolUses projection.
 *
 * Forward leg reuses the deterministic-compaction adapter's `toCore`
 * unmodified (R9) — and gets the D10 isError bridge for free, since
 * `toCore` already writes `meta: { isError: msg.isError === true }` for
 * every tool result, and `ERROR_RESULT_META_KEY === "isError"`.
 *
 * The reverse leg does NOT reuse the adapter's `fromCore`. `fromCore`
 * detects what to write back by looking for a `"compacted"` key inside
 * `meta` / `arguments` — a marker convention specific to
 * `compactCodeProductions`'s own summaries. `clearToolUses` doesn't stamp
 * any such marker (it just replaces `content` with the placeholder, or
 * `arguments` with `{}`), so reusing `fromCore` as-is would silently no-op:
 * clearing would run internally but never reach the outgoing send payload.
 * Forcing the marker convention onto clearToolUses's output was considered
 * and rejected — it would corrupt `clearToolInputs`'s documented `{}`
 * contract (compaction-core-flavored plumbing has no field to carry "this
 * was touched" separately from "here is the new value").
 *
 * Detection here uses `clearToolUses`'s own identity-preservation contract
 * instead: untouched core messages come back as the exact same object
 * reference (see packages/context-pruning G4a). Comparing
 * `projectedCore[i] !== originalCore[i]` by index is therefore a complete,
 * marker-free "did this change" test — new code, not a copy of adapter.ts's
 * logic.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { toCore, type ToCoreResult } from "./adapter.js";
import { clearToolUses, type ClearToolUsesConfig, type ClearToolUsesDeps, type ClearToolUsesReport, type Message } from "./context-pruning.js";

export interface TrcProjectionResult {
  messages: AgentMessage[];
  applied: boolean;
  report: ClearToolUsesReport;
}

export function projectContext(
  input: AgentMessage[],
  config: ClearToolUsesConfig,
  deps: ClearToolUsesDeps,
): TrcProjectionResult {
  const toCoreResult = toCore(input);
  const outcome = clearToolUses(toCoreResult.coreMessages, config, deps);

  if (!outcome.applied) {
    return { messages: input, applied: false, report: outcome.report };
  }

  const messages = applyClearedProjection(input, toCoreResult, toCoreResult.coreMessages, outcome.messages);
  return { messages, applied: true, report: outcome.report };
}

function applyClearedProjection(
  input: AgentMessage[],
  toCoreResult: ToCoreResult,
  originalCore: Message[],
  projectedCore: Message[],
): AgentMessage[] {
  const touchedByInputIndex = new Map<number, Message>();
  for (let coreIdx = 0; coreIdx < originalCore.length; coreIdx++) {
    const projectedMsg = projectedCore[coreIdx];
    if (projectedMsg !== undefined && projectedMsg !== originalCore[coreIdx]) {
      const inputIdx = toCoreResult.coreIndexToInputIndex[coreIdx];
      if (inputIdx !== undefined) touchedByInputIndex.set(inputIdx, projectedMsg);
    }
  }

  if (touchedByInputIndex.size === 0) return input;

  return input.map((original, index) => {
    const projected = touchedByInputIndex.get(index);
    if (!projected) return original;
    if ((original as { role?: string }).role === "toolResult") {
      return applyToolResultClearing(original as ToolResultMessage, projected);
    }
    if ((original as { role?: string }).role === "assistant") {
      return applyAssistantToolCallClearing(original as AssistantMessage, projected);
    }
    return original;
  });
}

function applyToolResultClearing(original: ToolResultMessage, projected: Message): ToolResultMessage {
  const block: TextContent = { type: "text", text: projected.content ?? "" };
  return { ...original, content: [block] };
}

function applyAssistantToolCallClearing(original: AssistantMessage, projected: Message): AssistantMessage {
  const projectedById = new Map((projected.toolCalls ?? []).map((call) => [call.id, call] as const));
  let changed = false;
  const newContent = original.content.map((block) => {
    if (block.type !== "toolCall") return block;
    const p = projectedById.get(block.id);
    if (!p || p.arguments === block.arguments) return block;
    changed = true;
    return { ...block, arguments: (p.arguments ?? {}) as Record<string, unknown> };
  });
  return changed ? { ...original, content: newContent } : original;
}

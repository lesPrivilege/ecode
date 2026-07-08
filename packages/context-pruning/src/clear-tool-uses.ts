/**
 * clear_tool_uses_20250919 replica — deterministic client-side send-time
 * projection. See docs/arch-frontier-pruning-design-2026-07-08.md §1-§3.
 */

import type {
  ClearToolUsesConfig,
  ClearToolUsesDeps,
  ClearToolUsesOutcome,
  Message,
  ToolCall,
} from "./types.js";

export const CLEAR_TOOL_USES_PLACEHOLDER =
  "[cleared by context-pruning: tool result removed to free context]";

/**
 * Convention bridging preserveErrorResults to the harness-agnostic Message
 * shape, which has no first-class isError field (unlike compaction-core's
 * separate ToolResult type). Not part of the reference spec — see G4a
 * open questions.
 */
export const ERROR_RESULT_META_KEY = "isError";

interface Pair {
  ownerIndex: number;
  call: ToolCall;
  resultIndex: number;
  resultMessage: Message;
}

function collectToolCallsInOrder(messages: Message[]): Array<{ call: ToolCall; ownerIndex: number }> {
  const calls: Array<{ call: ToolCall; ownerIndex: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        calls.push({ call, ownerIndex: i });
      }
    }
  }
  return calls;
}

function collectResultsByToolCallId(messages: Message[]): Map<string, { index: number; message: Message }> {
  const byId = new Map<string, { index: number; message: Message }>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "tool" && message.toolCallId !== undefined) {
      byId.set(message.toolCallId, { index: i, message });
    }
  }
  return byId;
}

/** Pairs, in the appearance order of their toolCall — oldest first. Unpaired calls/results are orphans and excluded. */
function collectPairs(messages: Message[]): Pair[] {
  const calls = collectToolCallsInOrder(messages);
  const resultsById = collectResultsByToolCallId(messages);
  const pairs: Pair[] = [];
  for (const { call, ownerIndex } of calls) {
    const found = resultsById.get(call.id);
    if (found) {
      pairs.push({ ownerIndex, call, resultIndex: found.index, resultMessage: found.message });
    }
  }
  return pairs;
}

function isErrorResult(message: Message): boolean {
  return message.meta?.[ERROR_RESULT_META_KEY] === true;
}

function shouldClearInputsFor(toolName: string, clearToolInputs: boolean | string[] | undefined): boolean {
  if (clearToolInputs === true) return true;
  if (!clearToolInputs) return false;
  return clearToolInputs.includes(toolName);
}

function identityOutcome(messages: Message[], gateReading: number, originalInputTokens: number): ClearToolUsesOutcome {
  return {
    messages,
    applied: false,
    report: {
      type: "clear_tool_uses_replica",
      clearedToolUses: 0,
      clearedInputTokens: 0,
      originalInputTokens,
      inputTokens: originalInputTokens,
      gateReading,
    },
  };
}

/**
 * Applies clearing for exactly `candidates`, honoring preserveErrorResults
 * (a full exemption — result AND inputs left untouched, not just the
 * result — see G4a open questions) and clearToolInputs.
 */
function applyClearing(
  messages: Message[],
  candidates: Pair[],
  config: ClearToolUsesConfig,
  placeholder: string,
): { messages: Message[]; clearedToolUses: number } {
  const preserve = config.preserveErrorResults === true;
  const toClear = preserve ? candidates.filter((pair) => !isErrorResult(pair.resultMessage)) : candidates;

  const resultIndicesToClear = new Set(toClear.map((p) => p.resultIndex));
  const inputClearsByOwner = new Map<number, Set<string>>();
  for (const pair of toClear) {
    if (shouldClearInputsFor(pair.call.name, config.clearToolInputs)) {
      if (!inputClearsByOwner.has(pair.ownerIndex)) {
        inputClearsByOwner.set(pair.ownerIndex, new Set());
      }
      inputClearsByOwner.get(pair.ownerIndex)?.add(pair.call.id);
    }
  }

  const nextMessages = messages.map((message, index) => {
    if (resultIndicesToClear.has(index)) {
      return { ...message, content: placeholder };
    }
    const idsToClear = inputClearsByOwner.get(index);
    if (idsToClear && message.toolCalls) {
      return {
        ...message,
        toolCalls: message.toolCalls.map((call) =>
          idsToClear.has(call.id) ? { ...call, arguments: {}, rawArguments: placeholder } : call,
        ),
      };
    }
    return message;
  });

  return { messages: nextMessages, clearedToolUses: toClear.length };
}

export function clearToolUses(
  messages: Message[],
  config: ClearToolUsesConfig,
  deps: ClearToolUsesDeps,
): ClearToolUsesOutcome {
  const placeholder = deps.placeholder ?? CLEAR_TOOL_USES_PLACEHOLDER;

  const pairs = collectPairs(messages);
  const totalToolUses = collectToolCallsInOrder(messages).length;
  const originalInputTokens = deps.estimateTokens(messages);
  const gateReading = config.trigger.type === "tool_uses" ? totalToolUses : originalInputTokens;

  if (!(gateReading > config.trigger.value)) {
    return identityOutcome(messages, gateReading, originalInputTokens);
  }

  const excludeSet = new Set(config.excludeTools ?? []);
  const nonExcludedPairs = pairs.filter((pair) => !excludeSet.has(pair.call.name));
  const candidateCount = Math.max(0, nonExcludedPairs.length - config.keep.value);
  const candidates = nonExcludedPairs.slice(0, candidateCount);

  if (candidates.length === 0) {
    return identityOutcome(messages, gateReading, originalInputTokens);
  }

  const { messages: clearedMessages, clearedToolUses } = applyClearing(messages, candidates, config, placeholder);

  if (clearedToolUses === 0) {
    // every candidate was exempted (e.g. preserveErrorResults filtered all of them)
    return identityOutcome(messages, gateReading, originalInputTokens);
  }

  const inputTokens = deps.estimateTokens(clearedMessages);
  const clearedInputTokens = originalInputTokens - inputTokens;

  if (config.clearAtLeast && clearedInputTokens < config.clearAtLeast.value) {
    return identityOutcome(messages, gateReading, originalInputTokens);
  }

  return {
    messages: clearedMessages,
    applied: true,
    report: {
      type: "clear_tool_uses_replica",
      clearedToolUses,
      clearedInputTokens,
      originalInputTokens,
      inputTokens,
      gateReading,
    },
  };
}

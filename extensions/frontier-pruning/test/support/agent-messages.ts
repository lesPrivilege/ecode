/**
 * Minimal AgentMessage fixture builders for tests.
 *
 * The exact full `AssistantMessage` / `ToolResultMessage` / `UserMessage`
 * shapes are not independently verified against pi's type declarations (out
 * of this packet's reading whitelist) — these builders reproduce the fields
 * actually observed in use across the three whitelisted deterministic-
 * compaction source files (adapter.ts, mock-provider.ts) and cast the rest.
 * If pi's real types require additional fields, `tsc --noEmit` on this
 * extension will surface it; vitest (esbuild, no type enforcement) will not.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall as PiToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export function userMsg(content: string, timestamp = 0): UserMessage {
  return { role: "user", content, timestamp } as unknown as UserMessage;
}

export function text(value: string): TextContent {
  return { type: "text", text: value };
}

export function toolCallBlock(id: string, name: string, args: Record<string, unknown>): PiToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function assistantMsg(content: AssistantMessage["content"], timestamp = 0): AssistantMessage {
  const hasToolCalls = content.some((b) => b.type === "toolCall");
  return {
    role: "assistant",
    content,
    api: "mock",
    provider: "mock",
    model: "mock-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: hasToolCalls ? "toolUse" : "stop",
    timestamp,
  } as unknown as AssistantMessage;
}

export function toolResultMsg(
  toolCallId: string,
  toolName: string,
  content: string,
  opts: { isError?: boolean; timestamp?: number } = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [text(content)],
    isError: opts.isError ?? false,
    timestamp: opts.timestamp ?? 0,
  } as unknown as ToolResultMessage;
}

export function asAgentMessages(...messages: (UserMessage | AssistantMessage | ToolResultMessage)[]): AgentMessage[] {
  return messages as unknown as AgentMessage[];
}

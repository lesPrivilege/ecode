import { describe, it, expect } from "vitest";
import { estimateTokensCharsDiv4 } from "../src/estimator.js";
import type { Message } from "../src/context-pruning.js";

function msg(overrides: Partial<Message> & { id: string; role: Message["role"] }): Message {
  return { createdAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

describe("estimateTokensCharsDiv4 (R3 — injected, decoupled from provider usage)", () => {
  it("sums content + thinking + toolCall(name/arguments/rawArguments) chars, divided by 4 (ceil)", () => {
    const messages: Message[] = [
      msg({ id: "1", role: "user", content: "abcd" }), // 4 chars
      msg({
        id: "2",
        role: "assistant",
        content: "ab", // 2
        thinking: "abcdefgh", // 8
        toolCalls: [
          {
            id: "t1",
            name: "abcd", // 4
            arguments: { x: 1 }, // JSON.stringify -> `{"x":1}` = 8 chars
            rawArguments: "ab", // 2
          },
        ],
      }),
    ];
    // total chars = 4 + 2 + 8 + 4 + 8 + 2 = 28 -> 28/4 = 7 exactly
    expect(estimateTokensCharsDiv4(messages)).toBe(7);
  });

  it("rounds up (ceil) when chars aren't a multiple of 4", () => {
    const messages: Message[] = [msg({ id: "1", role: "user", content: "abcde" })]; // 5 chars -> ceil(5/4) = 2
    expect(estimateTokensCharsDiv4(messages)).toBe(2);
  });

  it("is zero for an empty transcript and for messages with no content/toolCalls", () => {
    expect(estimateTokensCharsDiv4([])).toBe(0);
    expect(estimateTokensCharsDiv4([msg({ id: "1", role: "assistant" })])).toBe(0);
  });

  it("is monotonic: appending any message never decreases the estimate", () => {
    const base: Message[] = [msg({ id: "1", role: "user", content: "hello" })];
    const grown: Message[] = [...base, msg({ id: "2", role: "assistant", content: "world" })];
    expect(estimateTokensCharsDiv4(grown)).toBeGreaterThan(estimateTokensCharsDiv4(base));
  });

  it("deterministic: identical input yields identical output", () => {
    const messages: Message[] = [msg({ id: "1", role: "user", content: "repeat me" })];
    expect(estimateTokensCharsDiv4(messages)).toBe(estimateTokensCharsDiv4([...messages]));
  });

  it("R3 negative test: changing/adding provider-usage-shaped meta fields never moves the gate reading", () => {
    const withoutUsage: Message[] = [
      msg({ id: "1", role: "user", content: "same text, same tool calls" }),
      msg({
        id: "2",
        role: "assistant",
        content: "reply",
        toolCalls: [{ id: "t1", name: "read", arguments: { path: "/a" } }],
      }),
      msg({ id: "3", role: "tool", toolCallId: "t1", toolName: "read", content: "file body" }),
    ];
    // Structurally identical messages, but every message now carries a
    // usage-shaped meta bag whose numbers would (if read) swing the estimate
    // wildly — and the numbers themselves change between the two fixtures.
    const withUsageA: Message[] = withoutUsage.map((m) => ({
      ...m,
      meta: { ...m.meta, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 } },
    }));
    const withUsageB: Message[] = withoutUsage.map((m) => ({
      ...m,
      meta: { ...m.meta, usage: { inputTokens: 999_999, outputTokens: 999_999, cacheReadTokens: 999_999 } },
    }));

    const base = estimateTokensCharsDiv4(withoutUsage);
    expect(estimateTokensCharsDiv4(withUsageA)).toBe(base);
    expect(estimateTokensCharsDiv4(withUsageB)).toBe(base);
  });
});

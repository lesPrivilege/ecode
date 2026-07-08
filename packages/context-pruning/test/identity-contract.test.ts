/**
 * Pins the per-element identity contract that downstream marker-free change
 * detection now load-bears on (G4b acceptance, 2026-07-08):
 *
 *   extensions/frontier-pruning/src/projection.ts detects "was this core
 *   message cleared" by `projectedCore[i] !== originalCore[i]` — which is
 *   only a complete test because clearToolUses guarantees that UNTOUCHED
 *   messages come back as the exact same object reference, and TOUCHED
 *   messages come back as new objects.
 *
 * If clearToolUses is ever changed to rebuild untouched messages (breaking
 * reference identity), the downstream degradation is benign in values but
 * silently voids the detection contract — this test makes that change loud.
 */

import { describe, expect, it } from "vitest";
import { clearToolUses } from "../src/index.js";
import type { Message } from "../src/types.js";

const estimate = (messages: Message[]): number =>
  messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);

const pair = (n: number): Message[] => [
  {
    id: `a${n}`,
    role: "assistant",
    toolCalls: [{ id: `c${n}`, name: "read", arguments: { path: `/f${n}` } }],
    createdAt: "t",
  },
  {
    id: `r${n}`,
    role: "tool",
    toolCallId: `c${n}`,
    toolName: "read",
    content: "X".repeat(100),
    createdAt: "t",
  },
];

describe("per-element identity contract (load-bearing for frontier-pruning projection)", () => {
  it("returns untouched messages as the same reference and touched ones as new objects", () => {
    const messages = [...pair(1), ...pair(2), ...pair(3), ...pair(4), ...pair(5)];
    const outcome = clearToolUses(
      messages,
      { trigger: { type: "input_tokens", value: 1 }, keep: { type: "tool_uses", value: 3 } },
      { estimateTokens: estimate },
    );

    expect(outcome.applied).toBe(true);
    // keep=3 of 5 pairs -> pairs 1 and 2 cleared -> result messages at
    // indices 1 and 3 are replaced; everything else must keep identity.
    const clearedIndices = [1, 3];
    outcome.messages.forEach((message, index) => {
      if (clearedIndices.includes(index)) {
        expect(message).not.toBe(messages[index]);
      } else {
        expect(message).toBe(messages[index]);
      }
    });
  });
});

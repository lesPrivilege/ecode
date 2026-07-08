import { describe, it, expect } from "vitest";
import { clearToolUses, CLEAR_TOOL_USES_PLACEHOLDER, ERROR_RESULT_META_KEY } from "../src/index.js";
import type { Message, ClearToolUsesConfig, ClearToolUsesDeps } from "../src/index.js";

// Explicit fake estimator (msg content length sum) — packet-mandated pattern.
// Unit is self-consistent (chars), only ever compared against its own thresholds.
const fakeEstimateTokens = (messages: Message[]): number =>
  messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

function deps(overrides: Partial<ClearToolUsesDeps> = {}): ClearToolUsesDeps {
  return { estimateTokens: fakeEstimateTokens, ...overrides };
}

const P = CLEAR_TOOL_USES_PLACEHOLDER.length;

function ts(n: number): string {
  return `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
}

interface PairSpec {
  id: string;
  name: string;
  resultLen: number;
  argLen?: number;
  isError?: boolean;
}

function buildPairs(specs: PairSpec[]): Message[] {
  const messages: Message[] = [];
  specs.forEach((s, i) => {
    messages.push({
      id: `call-${s.id}`,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: s.id,
          name: s.name,
          arguments: { seq: i },
          rawArguments: "a".repeat(s.argLen ?? 4),
        },
      ],
      createdAt: ts(i * 2),
    });
    messages.push({
      id: `result-${s.id}`,
      role: "tool",
      toolCallId: s.id,
      toolName: s.name,
      content: "r".repeat(s.resultLen),
      createdAt: ts(i * 2 + 1),
      ...(s.isError ? { meta: { [ERROR_RESULT_META_KEY]: true } } : {}),
    });
  });
  return messages;
}

function contentAt(messages: Message[], toolCallId: string): string | undefined {
  return messages.find((m) => m.toolCallId === toolCallId)?.content;
}

function toolCallAt(messages: Message[], id: string) {
  const owner = messages.find((m) => m.toolCalls?.some((c) => c.id === id));
  return owner?.toolCalls?.find((c) => c.id === id);
}

describe("trigger boundaries — input_tokens vs tool_uses, strictly-greater activation", () => {
  const specs: PairSpec[] = [
    { id: "p1", name: "t", resultLen: 100 },
    { id: "p2", name: "t", resultLen: 100 },
    { id: "p3", name: "t", resultLen: 100 },
    { id: "p4", name: "t", resultLen: 100 },
    { id: "p5", name: "t", resultLen: 100 },
  ];
  // gateReading(input_tokens) = 500 ; gateReading(tool_uses) = 5

  it("input_tokens: below threshold is identity by reference", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 600 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
    expect(outcome.report).toEqual({
      type: "clear_tool_uses_replica",
      clearedToolUses: 0,
      clearedInputTokens: 0,
      originalInputTokens: 500,
      inputTokens: 500,
      gateReading: 500,
    });
  });

  it("input_tokens: exactly at threshold is identity (exceeds requires strictly-greater)", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 500 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
  });

  it("input_tokens: above threshold activates and clears the oldest candidates", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 400 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).not.toBe(messages);
    expect(outcome.applied).toBe(true);
    expect(outcome.report).toEqual({
      type: "clear_tool_uses_replica",
      clearedToolUses: 2,
      clearedInputTokens: 200 - 2 * P,
      originalInputTokens: 500,
      inputTokens: 2 * P + 300,
      gateReading: 500,
    });
  });

  it("tool_uses: below threshold is identity by reference", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 6 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
    expect(outcome.report.gateReading).toBe(5);
  });

  it("tool_uses: exactly at threshold is identity", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 5 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
  });

  it("tool_uses: above threshold activates", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 4 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.applied).toBe(true);
    expect(outcome.report.gateReading).toBe(5);
    expect(outcome.report.clearedToolUses).toBe(2);
  });
});

describe("keep window sliding & byte-stable monotonic growth", () => {
  const baseSpecs: PairSpec[] = [
    { id: "p1", name: "t", resultLen: 100 },
    { id: "p2", name: "t", resultLen: 100 },
    { id: "p3", name: "t", resultLen: 100 },
    { id: "p4", name: "t", resultLen: 100 },
    { id: "p5", name: "t", resultLen: 100 },
  ];
  const config: ClearToolUsesConfig = {
    trigger: { type: "tool_uses", value: 1 }, // always activates, unaffected by clearing
    keep: { type: "tool_uses", value: 3 },
  };

  it("clears exactly the oldest pairs beyond keep, leaves the rest byte-unchanged", () => {
    const messages = buildPairs(baseSpecs);
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.applied).toBe(true);
    expect(contentAt(outcome.messages, "p1")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "p2")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "p3")).toBe("r".repeat(100));
    expect(contentAt(outcome.messages, "p4")).toBe("r".repeat(100));
    expect(contentAt(outcome.messages, "p5")).toBe("r".repeat(100));
    expect(outcome.report.clearedToolUses).toBe(2);
  });

  it("growing the transcript ages exactly one more pair; prior placeholders stay byte-identical", () => {
    const messages = buildPairs(baseSpecs);
    const outcome1 = clearToolUses(messages, config, deps());

    const grown = [...outcome1.messages, ...buildPairs([{ id: "p6", name: "t", resultLen: 100 }])];
    const outcome2 = clearToolUses(grown, config, deps());

    expect(contentAt(outcome2.messages, "p1")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome2.messages, "p2")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome2.messages, "p1")).toBe(contentAt(outcome1.messages, "p1"));
    expect(contentAt(outcome2.messages, "p2")).toBe(contentAt(outcome1.messages, "p2"));

    // p3 was untouched in outcome1 but ages out of the keep window once p6 exists
    expect(contentAt(outcome1.messages, "p3")).toBe("r".repeat(100));
    expect(contentAt(outcome2.messages, "p3")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);

    // p4, p5, p6 remain within the keep=3 window
    expect(contentAt(outcome2.messages, "p4")).toBe("r".repeat(100));
    expect(contentAt(outcome2.messages, "p5")).toBe("r".repeat(100));
    expect(contentAt(outcome2.messages, "p6")).toBe("r".repeat(100));
  });
});

describe("clear order follows array appearance order, not id sort order", () => {
  it("orders by array position even when ids are reverse-alphabetical", () => {
    const specs: PairSpec[] = [
      { id: "e", name: "t", resultLen: 50 },
      { id: "d", name: "t", resultLen: 50 },
      { id: "c", name: "t", resultLen: 50 },
      { id: "b", name: "t", resultLen: 50 },
      { id: "a", name: "t", resultLen: 50 },
    ];
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 3 },
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(contentAt(outcome.messages, "e")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "d")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "c")).toBe("r".repeat(50));
    expect(contentAt(outcome.messages, "b")).toBe("r".repeat(50));
    expect(contentAt(outcome.messages, "a")).toBe("r".repeat(50));
  });
});

describe("excludeTools", () => {
  it("excluded pairs are never cleared and do not occupy keep slots (D5)", () => {
    const specs: PairSpec[] = [
      { id: "p1", name: "normal", resultLen: 50 },
      { id: "p2", name: "excluded", resultLen: 50 },
      { id: "p3", name: "normal", resultLen: 50 },
      { id: "p4", name: "normal", resultLen: 50 },
      { id: "p5", name: "normal", resultLen: 50 },
    ];
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 3 },
      excludeTools: ["excluded"],
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(contentAt(outcome.messages, "p1")).toBe(CLEAR_TOOL_USES_PLACEHOLDER); // oldest non-excluded, beyond keep
    expect(contentAt(outcome.messages, "p2")).toBe("r".repeat(50)); // excluded, never touched
    expect(contentAt(outcome.messages, "p3")).toBe("r".repeat(50)); // within keep=3 non-excluded floor
    expect(contentAt(outcome.messages, "p4")).toBe("r".repeat(50));
    expect(contentAt(outcome.messages, "p5")).toBe("r".repeat(50));
    expect(outcome.report.clearedToolUses).toBe(1);
  });

  it("excluding every tool present empties the candidate set — identity by reference", () => {
    const specs: PairSpec[] = [
      { id: "p1", name: "only", resultLen: 50 },
      { id: "p2", name: "only", resultLen: 50 },
      { id: "p3", name: "only", resultLen: 50 },
    ];
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 }, // guarantees activation
      keep: { type: "tool_uses", value: 1 },
      excludeTools: ["only"],
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
    expect(outcome.report.clearedToolUses).toBe(0);
  });
});

describe("clearAtLeast — all-or-nothing applicability gate (D8)", () => {
  const specs: PairSpec[] = [
    { id: "p1", name: "t", resultLen: 100 },
    { id: "p2", name: "t", resultLen: 100 },
    { id: "p3", name: "t", resultLen: 100 },
    { id: "p4", name: "t", resultLen: 100 },
    { id: "p5", name: "t", resultLen: 100 },
    { id: "p6", name: "t", resultLen: 100 },
  ];
  // keep=2 -> candidates = p1..p4 (4), full-set yield = 400 - 4P

  it("once satisfied, clears the ENTIRE candidate set in one shot — not merely enough to cross the gate", () => {
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 2 },
      clearAtLeast: { type: "input_tokens", value: 1 }, // trivially satisfied by even one pair
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.applied).toBe(true);
    // NOT 1 — a stop-once-satisfied (LangChain-style) implementation would clear only 1.
    expect(outcome.report.clearedToolUses).toBe(4);
    expect(outcome.report.clearedInputTokens).toBe(400 - 4 * P);
  });

  it("D8 counter-example: full-candidate-set yield below clearAtLeast clears NOTHING (no stop-loss partial clear)", () => {
    const messages = buildPairs(specs);
    const fullYield = 400 - 4 * P;
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 2 },
      clearAtLeast: { type: "input_tokens", value: fullYield + 1 }, // just barely unreachable
    };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
    expect(outcome.report.clearedToolUses).toBe(0);
    expect(outcome.report.clearedInputTokens).toBe(0);
    expect(outcome.report.inputTokens).toBe(outcome.report.originalInputTokens);
  });
});

describe("clearToolInputs tri-state (false / true / string[]) — D7", () => {
  const specs: PairSpec[] = [
    { id: "p1", name: "tool_a", resultLen: 30, argLen: 12 },
    { id: "p2", name: "tool_b", resultLen: 30, argLen: 12 },
    { id: "p3", name: "tool_a", resultLen: 30, argLen: 12 }, // kept (within keep=1)
  ];
  const baseConfig = {
    trigger: { type: "tool_uses" as const, value: 1 },
    keep: { type: "tool_uses" as const, value: 1 },
  };

  it("false (default): only results are cleared, toolCall arguments stay visible", () => {
    const messages = buildPairs(specs);
    const outcome = clearToolUses(messages, { ...baseConfig, clearToolInputs: false }, deps());
    expect(toolCallAt(outcome.messages, "p1")?.arguments).toEqual({ seq: 0 });
    expect(toolCallAt(outcome.messages, "p1")?.rawArguments).toBe("a".repeat(12));
    expect(toolCallAt(outcome.messages, "p2")?.arguments).toEqual({ seq: 1 });
  });

  it("true: every cleared pair's toolCall inputs are blanked", () => {
    const messages = buildPairs(specs);
    const outcome = clearToolUses(messages, { ...baseConfig, clearToolInputs: true }, deps());
    expect(toolCallAt(outcome.messages, "p1")?.arguments).toEqual({});
    expect(toolCallAt(outcome.messages, "p1")?.rawArguments).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(toolCallAt(outcome.messages, "p2")?.arguments).toEqual({});
    expect(toolCallAt(outcome.messages, "p2")?.rawArguments).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    // p3 is retained (never a candidate) — immune regardless of clearToolInputs
    expect(toolCallAt(outcome.messages, "p3")?.arguments).toEqual({ seq: 2 });
  });

  it("string[]: only the named tools have inputs cleared", () => {
    const messages = buildPairs(specs);
    const outcome = clearToolUses(messages, { ...baseConfig, clearToolInputs: ["tool_a"] }, deps());
    expect(toolCallAt(outcome.messages, "p1")?.arguments).toEqual({}); // tool_a, cleared
    expect(toolCallAt(outcome.messages, "p1")?.rawArguments).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(toolCallAt(outcome.messages, "p2")?.arguments).toEqual({ seq: 1 }); // tool_b, untouched
    expect(toolCallAt(outcome.messages, "p2")?.rawArguments).toBe("a".repeat(12));
  });
});

describe("preserveErrorResults — D4 (default false, spec-faithful)", () => {
  const specs: PairSpec[] = [
    { id: "p1", name: "t", resultLen: 40, isError: true },
    { id: "p2", name: "t", resultLen: 40 },
    { id: "p3", name: "t", resultLen: 40 }, // kept (within keep=1)
  ];
  const baseConfig = {
    trigger: { type: "tool_uses" as const, value: 1 },
    keep: { type: "tool_uses" as const, value: 1 },
  };

  it("false (default): error results are cleared like any other", () => {
    const messages = buildPairs(specs);
    const outcome = clearToolUses(messages, { ...baseConfig, preserveErrorResults: false }, deps());
    expect(contentAt(outcome.messages, "p1")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "p2")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(outcome.report.clearedToolUses).toBe(2);
  });

  it("true: error results are preserved, non-error candidates still cleared", () => {
    const messages = buildPairs(specs);
    const outcome = clearToolUses(messages, { ...baseConfig, preserveErrorResults: true }, deps());
    expect(contentAt(outcome.messages, "p1")).toBe("r".repeat(40)); // preserved
    expect(contentAt(outcome.messages, "p2")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(outcome.report.clearedToolUses).toBe(1);
  });

  it("preserving every candidate down to zero still yields identity", () => {
    const allErrorSpecs: PairSpec[] = [
      { id: "p1", name: "t", resultLen: 40, isError: true },
      { id: "p2", name: "t", resultLen: 40, isError: true },
      { id: "p3", name: "t", resultLen: 40 }, // kept
    ];
    const messages = buildPairs(allErrorSpecs);
    const config: ClearToolUsesConfig = { ...baseConfig, preserveErrorResults: true };
    const outcome = clearToolUses(messages, config, deps());
    expect(outcome.messages).toBe(messages);
    expect(outcome.applied).toBe(false);
    expect(outcome.report.clearedToolUses).toBe(0);
  });
});

describe("idempotence", () => {
  it("f(f(x)) deep-equals f(x) when the trigger reading is unaffected by clearing (tool_uses gate)", () => {
    const specs: PairSpec[] = [
      { id: "p1", name: "t", resultLen: 100 },
      { id: "p2", name: "t", resultLen: 100 },
      { id: "p3", name: "t", resultLen: 100 },
      { id: "p4", name: "t", resultLen: 100 },
      { id: "p5", name: "t", resultLen: 100 },
    ];
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 3 },
    };
    const once = clearToolUses(messages, config, deps());
    const twice = clearToolUses(once.messages, config, deps());
    expect(twice.messages).toEqual(once.messages);
  });
});

describe("orphan pairing", () => {
  it("orphan call (no result) and orphan result (no call) are never touched, even with clearToolInputs:true", () => {
    const messages: Message[] = [
      ...buildPairs([{ id: "p1", name: "t", resultLen: 40 }]),
      {
        id: "call-orphan",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "orphan-call", name: "t", arguments: { x: 1 }, rawArguments: "orig" }],
        createdAt: ts(20),
      },
      {
        id: "orphan-result-msg",
        role: "tool",
        toolCallId: "orphan-result-id",
        toolName: "t",
        content: "orphan-result-content",
        createdAt: ts(21),
      },
      ...buildPairs([
        { id: "p2", name: "t", resultLen: 40 },
        { id: "p3", name: "t", resultLen: 40 },
        { id: "p4", name: "t", resultLen: 40 },
      ]),
    ];
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 3 }, // p1..p4 real pairs; oldest 1 (p1) clears
      clearToolInputs: true,
    };
    const outcome = clearToolUses(messages, config, deps());

    const orphanCallMsg = outcome.messages.find((m) => m.id === "call-orphan");
    expect(orphanCallMsg?.toolCalls?.[0]?.arguments).toEqual({ x: 1 });
    expect(orphanCallMsg?.toolCalls?.[0]?.rawArguments).toBe("orig");

    const orphanResultMsg = outcome.messages.find((m) => m.id === "orphan-result-msg");
    expect(orphanResultMsg?.content).toBe("orphan-result-content");

    // real pairing/clearing still proceeds correctly around the orphans
    expect(contentAt(outcome.messages, "p1")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(contentAt(outcome.messages, "p2")).toBe("r".repeat(40));
    expect(outcome.report.clearedToolUses).toBe(1);

    // p1, a real candidate, DOES get its inputs cleared under clearToolInputs:true
    expect(toolCallAt(outcome.messages, "p1")?.arguments).toEqual({});
    expect(toolCallAt(outcome.messages, "p1")?.rawArguments).toBe(CLEAR_TOOL_USES_PLACEHOLDER);

    // tool_uses gate reading counts the orphan call as a tool use, even though it never becomes a candidate
    expect(outcome.report.gateReading).toBe(5); // p1..p4 calls + orphan-call
  });
});

describe("comprehensive report hand-calculation (excludeTools + clearToolInputs list + clearAtLeast + preserveErrorResults combined)", () => {
  it("matches hand-computed report fields exactly", () => {
    const specs: PairSpec[] = [
      { id: "p1", name: "tool_a", resultLen: 80, argLen: 6, isError: true },
      { id: "p2", name: "tool_x", resultLen: 80, argLen: 6 },
      { id: "p3", name: "tool_b", resultLen: 80, argLen: 6 },
      { id: "p4", name: "tool_a", resultLen: 80, argLen: 6 },
      { id: "p5", name: "tool_b", resultLen: 80, argLen: 6 },
      { id: "p6", name: "tool_a", resultLen: 80, argLen: 6 },
    ];
    const messages = buildPairs(specs);
    const config: ClearToolUsesConfig = {
      trigger: { type: "tool_uses", value: 1 },
      keep: { type: "tool_uses", value: 2 },
      excludeTools: ["tool_x"],
      clearToolInputs: ["tool_a"],
      preserveErrorResults: true,
      clearAtLeast: { type: "input_tokens", value: 1 },
    };
    const outcome = clearToolUses(messages, config, deps());

    // non-excluded: p1,p3,p4,p5,p6 (5) ; keep=2 -> retain p5,p6 ; candidates = p1,p3,p4
    // p1 is an error candidate under preserveErrorResults:true -> fully exempt (result AND inputs)
    // p3 (tool_b, not in clearToolInputs list) -> result cleared, inputs untouched
    // p4 (tool_a, in clearToolInputs list) -> result cleared, inputs cleared
    expect(outcome.applied).toBe(true);
    expect(outcome.report).toEqual({
      type: "clear_tool_uses_replica",
      clearedToolUses: 2,
      clearedInputTokens: 160 - 2 * P,
      originalInputTokens: 480,
      inputTokens: 320 + 2 * P,
      gateReading: 6,
    });

    expect(contentAt(outcome.messages, "p1")).toBe("r".repeat(80));
    expect(toolCallAt(outcome.messages, "p1")).toEqual({
      id: "p1",
      name: "tool_a",
      arguments: { seq: 0 },
      rawArguments: "a".repeat(6),
    });

    expect(contentAt(outcome.messages, "p2")).toBe("r".repeat(80)); // excluded tool, never touched

    expect(contentAt(outcome.messages, "p3")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(toolCallAt(outcome.messages, "p3")?.arguments).toEqual({ seq: 2 });
    expect(toolCallAt(outcome.messages, "p3")?.rawArguments).toBe("a".repeat(6));

    expect(contentAt(outcome.messages, "p4")).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(toolCallAt(outcome.messages, "p4")?.arguments).toEqual({});
    expect(toolCallAt(outcome.messages, "p4")?.rawArguments).toBe(CLEAR_TOOL_USES_PLACEHOLDER);

    expect(contentAt(outcome.messages, "p5")).toBe("r".repeat(80)); // retained
    expect(contentAt(outcome.messages, "p6")).toBe("r".repeat(80)); // retained
  });
});

describe("placeholder constant", () => {
  it("is a fixed constant with no embedded variable content", () => {
    expect(typeof CLEAR_TOOL_USES_PLACEHOLDER).toBe("string");
    expect(CLEAR_TOOL_USES_PLACEHOLDER.length).toBeGreaterThan(0);
    // no digit runs (timestamps/token counts) or template artifacts embedded
    expect(CLEAR_TOOL_USES_PLACEHOLDER).not.toMatch(/\d/);
    expect(CLEAR_TOOL_USES_PLACEHOLDER).not.toMatch(/\$\{/);
  });
});

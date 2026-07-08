import { describe, it, expect } from "vitest";
import { projectContext } from "../src/projection.js";
import {
  CLEAR_TOOL_USES_PLACEHOLDER,
  ERROR_RESULT_META_KEY,
  type ClearToolUsesConfig,
  type ClearToolUsesDeps,
  type Message,
} from "../src/context-pruning.js";
import { assistantMsg, asAgentMessages, toolCallBlock, toolResultMsg } from "./support/agent-messages.js";

const fakeEstimateTokens = (messages: Message[]): number =>
  messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);

function deps(overrides: Partial<ClearToolUsesDeps> = {}): ClearToolUsesDeps {
  return { estimateTokens: fakeEstimateTokens, ...overrides };
}

function pairTranscript(resultLens: number[]) {
  const messages: (ReturnType<typeof assistantMsg> | ReturnType<typeof toolResultMsg>)[] = [];
  resultLens.forEach((len, i) => {
    messages.push(assistantMsg([toolCallBlock(`t${i}`, "read", { path: `/f${i}` })], i * 2));
    messages.push(toolResultMsg(`t${i}`, "read", "r".repeat(len), { timestamp: i * 2 + 1 }));
  });
  return asAgentMessages(...messages);
}

describe("projectContext — adapter (toCore, reused) -> clearToolUses -> new inverse mapper", () => {
  it("below threshold: full identity, same AgentMessage[] reference", () => {
    const input = pairTranscript([100, 100, 100, 100, 100]);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 10_000 },
      keep: { type: "tool_uses", value: 3 },
      clearToolInputs: false,
      preserveErrorResults: false,
    };
    const result = projectContext(input, config, deps());
    expect(result.messages).toBe(input);
    expect(result.applied).toBe(false);
  });

  it("above threshold: clears the oldest pair's result content, leaves everything else — including object references — untouched", () => {
    const input = pairTranscript([100, 100, 100, 100, 100]);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 1 },
      keep: { type: "tool_uses", value: 3 },
      clearToolInputs: false,
      preserveErrorResults: false,
    };
    const result = projectContext(input, config, deps());
    expect(result.applied).toBe(true);
    expect(result.messages).not.toBe(input);
    expect(result.messages).toHaveLength(input.length);

    // index 1 = result of t0 (oldest, cleared); index 3 = result of t1 (cleared, keep=3 -> 2 candidates)
    expect((result.messages[1] as any).content[0].text).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    expect((result.messages[3] as any).content[0].text).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    // index 5,7,9 = results of t2,t3,t4 -> retained, byte + reference unchanged
    expect(result.messages[5]).toBe(input[5]);
    expect(result.messages[7]).toBe(input[7]);
    expect(result.messages[9]).toBe(input[9]);
    // untouched assistant messages (owners of retained calls) keep their reference too
    expect(result.messages[4]).toBe(input[4]);
    expect(result.messages[6]).toBe(input[6]);
    expect(result.messages[8]).toBe(input[8]);
  });

  it("clearToolInputs:true blanks the toolCall block's arguments on cleared pairs, not on retained ones", () => {
    const input = pairTranscript([100, 100, 100, 100, 100]);
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 1 },
      keep: { type: "tool_uses", value: 3 },
      clearToolInputs: true,
      preserveErrorResults: false,
    };
    const result = projectContext(input, config, deps());

    const clearedCallBlock = (result.messages[0] as any).content[0];
    expect(clearedCallBlock.arguments).toEqual({});

    const retainedCallBlock = (result.messages[4] as any).content[0];
    expect(retainedCallBlock.arguments).toEqual({ path: "/f2" });
    // retained assistant message is untouched by reference too
    expect(result.messages[4]).toBe(input[4]);
  });

  it("D10 bridge: pi isError survives toCore into meta[ERROR_RESULT_META_KEY], preserveErrorResults exempts it", () => {
    const input = asAgentMessages(
      assistantMsg([toolCallBlock("e1", "run", { cmd: "boom" })], 0),
      toolResultMsg("e1", "run", "x".repeat(200), { isError: true, timestamp: 1 }),
      assistantMsg([toolCallBlock("n1", "run", { cmd: "ok" })], 2),
      toolResultMsg("n1", "run", "y".repeat(200), { timestamp: 3 }),
      assistantMsg([toolCallBlock("n2", "run", { cmd: "ok2" })], 4),
      toolResultMsg("n2", "run", "z".repeat(200), { timestamp: 5 }), // kept (within keep=1)
    );
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 1 },
      keep: { type: "tool_uses", value: 1 },
      clearToolInputs: false,
      preserveErrorResults: true,
    };
    const result = projectContext(input, config, deps());

    // error pair (e1) preserved verbatim, including object reference
    expect(result.messages[1]).toBe(input[1]);
    // non-error pair (n1) cleared
    expect((result.messages[3] as any).content[0].text).not.toBe("y".repeat(200));
    expect(result.report.clearedToolUses).toBe(1);
  });

  it("passthrough (non-LLM) messages are preserved untouched at their original index", () => {
    const custom = { role: "custom-notification", note: "hello" } as any;
    const pairs = pairTranscript([100, 100, 100, 100, 100]);
    const input = [pairs[0], pairs[1], custom, ...pairs.slice(2)] as any;
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 1 },
      keep: { type: "tool_uses", value: 3 },
      clearToolInputs: false,
      preserveErrorResults: false,
    };
    const result = projectContext(input, config, deps());
    expect(result.messages[2]).toBe(custom);
  });

  it("report numbers match a hand-calculated fixture", () => {
    const input = pairTranscript([50, 50, 50, 50]); // keep=2 -> 2 candidates cleared
    const config: ClearToolUsesConfig = {
      trigger: { type: "input_tokens", value: 1 },
      keep: { type: "tool_uses", value: 2 },
      clearToolInputs: false,
      preserveErrorResults: false,
    };
    const result = projectContext(input, config, deps());
    expect((result.messages[1] as any).content[0].text).toBe(CLEAR_TOOL_USES_PLACEHOLDER);
    const placeholderLen = CLEAR_TOOL_USES_PLACEHOLDER.length;

    expect(result.report.originalInputTokens).toBe(200); // 4 * 50
    expect(result.report.clearedToolUses).toBe(2);
    expect(result.report.inputTokens).toBe(2 * placeholderLen + 100); // 2 cleared + 2 kept @ 50
    expect(result.report.clearedInputTokens).toBe(200 - (2 * placeholderLen + 100));
    expect(result.report.gateReading).toBe(200);
  });
});

describe("ERROR_RESULT_META_KEY re-export sanity", () => {
  it("is the literal string the reused adapter already writes into meta.isError", () => {
    expect(ERROR_RESULT_META_KEY).toBe("isError");
  });
});

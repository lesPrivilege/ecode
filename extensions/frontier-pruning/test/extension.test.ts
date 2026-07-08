import { describe, it, expect, vi } from "vitest";
import { createContextHookHandler, default as frontierPruningExtension } from "../src/extension.js";
import { asAgentMessages, assistantMsg, toolCallBlock, toolResultMsg } from "./support/agent-messages.js";

function pairTranscript(resultLens: number[]) {
  const messages: (ReturnType<typeof assistantMsg> | ReturnType<typeof toolResultMsg>)[] = [];
  resultLens.forEach((len, i) => {
    messages.push(assistantMsg([toolCallBlock(`t${i}`, "read", { path: `/f${i}` })], i * 2));
    messages.push(toolResultMsg(`t${i}`, "read", "r".repeat(len), { timestamp: i * 2 + 1 }));
  });
  return asAgentMessages(...messages);
}

describe("createContextHookHandler — flags integration", () => {
  it("ECODE_TRC unset/off: reference passthrough, no work done", () => {
    const handler = createContextHookHandler({});
    const input = pairTranscript([1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    const result = handler(input);
    expect(result.messages).toBe(input);
  });

  it("ECODE_TRC=1, below the (default 100000-token) trigger: reference passthrough", () => {
    const handler = createContextHookHandler({ ECODE_TRC: "1" });
    const input = pairTranscript([100, 100, 100, 100]); // tiny transcript, nowhere near 100k chars/4
    const result = handler(input);
    expect(result.messages).toBe(input);
  });

  it("ECODE_TRC=1 with a low ECODE_TRC_TRIGGER_TOKENS: clears using the REAL chars/4 estimator end-to-end", () => {
    const handler = createContextHookHandler({
      ECODE_TRC: "1",
      ECODE_TRC_TRIGGER_TOKENS: "1",
      ECODE_TRC_KEEP: "1",
    });
    const input = pairTranscript([2000, 2000, 2000]); // keep=1 -> oldest 2 pairs cleared
    const result = handler(input);
    expect(result.messages).not.toBe(input);
    expect((result.messages[1] as any).content[0].text.length).toBeLessThan(2000);
    expect((result.messages[3] as any).content[0].text.length).toBeLessThan(2000);
    expect(result.messages[5]).toBe(input[5]); // retained pair, untouched by reference
  });
});

describe("frontierPruningExtension — pi.on(\"context\", ...) registration wiring", () => {
  it("registers a context handler that extracts event.messages and returns {messages}", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const fakePi = {
      on: vi.fn((eventType: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(eventType, handler);
      }),
    };

    frontierPruningExtension(fakePi as any, { ECODE_TRC: "1", ECODE_TRC_TRIGGER_TOKENS: "1", ECODE_TRC_KEEP: "0" });

    expect(fakePi.on).toHaveBeenCalledWith("context", expect.any(Function));
    const contextHandler = handlers.get("context");
    expect(contextHandler).toBeDefined();

    const input = pairTranscript([500, 500]);
    const output = contextHandler!({ messages: input }, {}) as { messages: unknown[] };
    expect(output.messages).not.toBe(input);
    expect(output.messages).toHaveLength(input.length);
  });
});

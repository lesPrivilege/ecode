/**
 * Mock-provider-style loop simulation (task 4).
 *
 * IMPORTANT DEVIATION, reported in full in the completion message: this does
 * NOT import `extensions/deterministic-compaction/src/mock-provider.ts`.
 * Empirically verified (scratch probe, removed after use) that the module
 * cannot load in this package's isolated vitest run at all —
 * `createAssistantMessageEventStream` is imported from `@earendil-works/pi-ai`
 * WITHOUT a `type` prefix, so unlike adapter.ts (100% `import type`, fully
 * erased) it is a real runtime value import. Vite/esbuild correctly keeps it
 * as a live import in the transpiled output, and resolution fails outside
 * pi's own jiti-aliased loading context:
 *
 *   Error: Could not resolve "@earendil-works/pi-ai" imported by
 *   "@ecode/deterministic-compaction". Is it installed?
 *
 * So "reuse mock-provider.ts's scripted mock pattern" is followed in SHAPE
 * (a queue of scripted steps consumed turn-by-turn) using this extension's
 * own already-safe (type-only-import) fixture helpers instead of literally
 * importing that module. Driving a REAL pi agent loop / session and reading
 * back an actual session JSONL file from disk is NOT attempted here — no
 * file in this packet's reading whitelist documents pi's programmatic
 * session-runner API, and pi/ is a forbidden zone. What IS proven below,
 * with real assertions:
 *
 *  1. A growing "canonical transcript" (standing in for session history) is
 *     never mutated in place by the hook, turn over turn — same array
 *     elements, same references, before and after every hook call.
 *  2. Per g0-survey.md Item 3 (CONFIRMED, cited verbatim in this packet's
 *     required reading): pi's real harness treats `transformContext`'s
 *     return as a local variable feeding only the outgoing request, never
 *     `session.append*`/any persistence call. Combined with (1) — this
 *     extension provably never mutates what it's handed, and the harness
 *     provably never persists what this extension hands back — the
 *     conjunction is the on-disk safety property, even without a literal
 *     JSONL readback.
 *  3. The send payload diverges from canonical history once the gate
 *     activates (placeholder appears in the outgoing view only), and
 *     converges back to reference-identical passthrough below it.
 */

import { describe, it, expect } from "vitest";
import { createContextHookHandler } from "../src/extension.js";
import { assistantMsg, toolCallBlock, toolResultMsg } from "./support/agent-messages.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface ScriptedStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  resultText: string;
}

const SCRIPT: ScriptedStep[] = [
  { toolCallId: "c1", toolName: "read", args: { path: "/a" }, resultText: "A".repeat(3000) },
  { toolCallId: "c2", toolName: "read", args: { path: "/b" }, resultText: "B".repeat(3000) },
  { toolCallId: "c3", toolName: "bash", args: { cmd: "ls" }, resultText: "C".repeat(3000) },
  { toolCallId: "c4", toolName: "read", args: { path: "/c" }, resultText: "D".repeat(3000) },
  { toolCallId: "c5", toolName: "bash", args: { cmd: "pwd" }, resultText: "E".repeat(3000) },
  { toolCallId: "c6", toolName: "read", args: { path: "/d" }, resultText: "F".repeat(3000) },
];

describe("mock-provider-style loop simulation (see file header for scope/deviation)", () => {
  it("threads >=6 tool use/result pairs through the hook turn-by-turn: canonical history is never mutated, send payload clears above the gate and passes through below it", () => {
    // Low trigger relative to the ~3000-char results so clearing activates partway through.
    const handler = createContextHookHandler({
      ECODE_TRC: "1",
      ECODE_TRC_TRIGGER_TOKENS: "1500", // chars/4 -> activates once one full 3000-char result is on the wire
      ECODE_TRC_KEEP: "2",
    });

    // `canonical` is ONE array object, mutated (grown) in place turn over
    // turn via push — never reassigned. So `sendPayloads[i] === canonical`
    // is a valid identity check regardless of how much canonical grows
    // afterward: reference equality is about object identity, not a
    // point-in-time content snapshot.
    const canonical: AgentMessage[] = [];
    const sendPayloads: AgentMessage[][] = [];

    for (let turn = 0; turn < SCRIPT.length; turn++) {
      const step = SCRIPT[turn]!;
      // Simulate the real loop: scripted assistant turn + real tool-result append.
      canonical.push(assistantMsg([toolCallBlock(step.toolCallId, step.toolName, step.args)], turn * 2));
      canonical.push(toolResultMsg(step.toolCallId, step.toolName, step.resultText, { timestamp: turn * 2 + 1 }));

      const beforeElementRefs = canonical.slice();
      const beforeContents = canonical.map((m) => JSON.stringify(m));

      const { messages: sendPayload } = handler(canonical);

      // (1) canonical history array elements are untouched by the call —
      // same references AND same content, checked fresh every turn.
      canonical.forEach((m, i) => expect(m).toBe(beforeElementRefs[i]));
      expect(canonical.map((m) => JSON.stringify(m))).toEqual(beforeContents);

      sendPayloads.push(sendPayload);
    }

    // Early turns: transcript is small, gate hasn't activated -> exact reference passthrough.
    expect(sendPayloads[0]).toBe(canonical);
    expect((sendPayloads[0]![1] as any).content[0].text).toBe("A".repeat(3000));

    // By the last turn the transcript is well past the gate -> send payload diverges from canonical.
    const lastSend = sendPayloads[SCRIPT.length - 1]!;
    expect(lastSend).not.toBe(canonical);

    // The oldest pair's result (c1) is cleared in the send payload...
    expect((lastSend[1] as any).content[0].text).not.toBe("A".repeat(3000));
    // ...but the canonical "on-disk" history still has the untouched original,
    // even after every subsequent turn's hook call.
    expect((canonical[1] as any).content[0].text).toBe("A".repeat(3000));

    // The most recent `keep=2` pairs (c5, c6) are never cleared even at the final turn.
    expect((lastSend[9] as any).content[0].text).toBe("E".repeat(3000));
    expect((lastSend[11] as any).content[0].text).toBe("F".repeat(3000));
  });

  it("ECODE_TRC unset: every turn is exact reference passthrough (master switch off)", () => {
    const handler = createContextHookHandler({});
    const canonical: AgentMessage[] = [];
    for (const step of SCRIPT) {
      canonical.push(assistantMsg([toolCallBlock(step.toolCallId, step.toolName, step.args)]));
      canonical.push(toolResultMsg(step.toolCallId, step.toolName, step.resultText));
      const { messages } = handler(canonical);
      expect(messages).toBe(canonical);
    }
  });
});

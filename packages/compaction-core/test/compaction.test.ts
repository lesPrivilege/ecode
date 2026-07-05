import { describe, it, expect } from "vitest";
import { compactCodeProductions, isCompacted } from "../src/compaction.js";
import {
  buildCompactionReviewPayload,
  projectCompaction,
} from "../src/compaction-report.js";
import type { Message } from "../src/types.js";

function makeAssistantWithToolCall(
  id: string,
  toolCallId: string,
  toolName: string,
  args: unknown,
): Message {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ id: toolCallId, name: toolName, arguments: args }],
    createdAt: new Date().toISOString(),
  };
}

function makeToolResultMessage(toolCallId: string, content: string): Message {
  return {
    id: `tr-${toolCallId}`,
    role: "tool",
    toolCallId,
    toolName: "write",
    content,
    createdAt: new Date().toISOString(),
  };
}

function makeReadResultMessage(
  toolCallId: string,
  content: string,
  meta?: Record<string, unknown>,
): Message {
  return {
    id: `tr-${toolCallId}`,
    role: "tool",
    toolCallId,
    toolName: "read",
    content,
    createdAt: new Date().toISOString(),
    meta,
  };
}

function makeUserMessage(id: string, content: string): Message {
  return {
    id,
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function makeLargeCodeContent(lineCount: number = 200): string {
  return Array.from(
    { length: lineCount },
    (_, i) => `export const value${i} = ${i};`,
  ).join("\n");
}

function makeHashlineReadContent(
  path: string,
  lineCount: number = 200,
): string {
  const lines = Array.from(
    { length: lineCount },
    (_, i) => `${i + 1}:export const value${i} = ${i};`,
  );
  return `¶${path}#1234abcd\n${lines.join("\n")}`;
}

describe("projectCompaction", () => {
  it("keeps projection inactive below compactAfterInputTokens", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    const report = projectCompaction({
      messages,
      rawTokens: 500,
      compactAfterInputTokens: 1_000,
      compactionOptions: { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      estimateTokens: () => 100,
    });

    expect(report.triggerState).toBe("waiting");
    expect(report.active).toBe(false);
    expect(report.messages).toBe(messages);
    expect(report.compactedCount).toBe(0);
    expect(report.compactedTokens).toBe(500);
  });

  it("returns a review payload without embedding projected messages", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    const report = projectCompaction({
      messages,
      rawTokens: 2_000,
      compactAfterInputTokens: 1_000,
      compactionOptions: { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      estimateTokens: () => 500,
    });
    const payload = buildCompactionReviewPayload(report);

    expect(report.triggerState).toBe("active");
    expect(report.compactedCount).toBe(1);
    expect(payload).not.toHaveProperty("messages");
    expect(payload.rawTokens).toBe(2_000);
    expect(payload.compactedTokens).toBe(500);
    expect(payload.effectiveTokensSaved).toBe(1_500);
  });
});

describe("compactCodeProductions", () => {
  it("does not mutate original messages", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    const original = messages[1]!.toolCalls![0]!.arguments;
    compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    expect(messages[1]!.toolCalls![0]!.arguments).toBe(original);
  });

  it("preserves tool call/result ids", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    const compacted = result.messages[1]!.toolCalls![0]!;
    expect(compacted.id).toBe("tc1");
    expect(compacted.name).toBe("write");
  });

  it("skips recent turns", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
      makeUserMessage("u2", "another"),
      makeAssistantWithToolCall("a2", "tc2", "write", {
        path: "bar.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc2", "wrote 4000 bytes"),
    ];

    // keepRecentAssistantMessages=1 should skip the last assistant message
    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1,
      minArgTokens: 100,
    });
    expect(result.compactedCount).toBe(1);
    // First assistant message should be compacted
    expect(isCompacted(result.messages[1]!)).toBe(true);
    // Second assistant message should NOT be compacted (recent)
    expect(isCompacted(result.messages[4]!)).toBe(false);
  });

  it("skips failed writes/edits", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      {
        id: "tr-tc1",
        role: "tool",
        toolCallId: "tc1",
        toolName: "write",
        content: "error: permission denied",
        createdAt: new Date().toISOString(),
        meta: { isError: true },
      },
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    // Should not compact because tool result is an error
    // (The tool result in our test doesn't have isError=true in the ToolResult sense,
    //  but the message doesn't match our tool result lookup pattern)
    expect(result.compactedCount).toBe(0);
  });

  it("skips small arguments", () => {
    const smallContent = "tiny";
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: smallContent,
      }),
      makeToolResultMessage("tc1", "wrote 4 bytes"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 800, // default
    });
    expect(result.compactedCount).toBe(0);
  });

  it("reports compacted count and estimated tokens saved", () => {
    // Use realistic code content that will actually save tokens when compacted
    const lines = Array.from(
      { length: 200 },
      (_, i) => `  function helper${i}() { return ${i} * 2; }`,
    );
    const largeContent = `export function main() {\n${lines.join("\n")}\n  return true;\n}`;
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", `wrote ${largeContent.length} bytes`),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    expect(result.compactedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);
    // Summary should be significantly smaller than original
    expect(result.tokensSaved).toBeGreaterThan(100);
    // details should have one entry for "write"
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.toolName).toBe("write");
    expect(result.details[0]!.compactedCount).toBe(1);
    expect(result.details[0]!.tokensSaved).toBeGreaterThan(0);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      messageId: "a1",
      messageIndex: 1,
      turn: 1,
      role: "assistant",
      kind: "tool_call",
      toolName: "write",
      toolCallId: "tc1",
      path: "foo.ts",
    });
    expect(result.diffs[0]!.rawTokens).toBeGreaterThan(
      result.diffs[0]!.compactedTokens,
    );
  });

  it("does not compact small writes", () => {
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: "short",
      }),
      makeToolResultMessage("tc1", "wrote 5 bytes"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });

    expect(result.compactedCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[1]!.toolCalls![0]!.arguments).toEqual({
      path: "foo.ts",
      content: "short",
    });
  });

  it("skips replacement when summary is not shorter", () => {
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", "short"),
      makeToolResultMessage("tc1", "wrote"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 1,
    });

    expect(result.compactedCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.messages[1]!.toolCalls![0]!.arguments).toBe("short");
  });

  it("compacts edit tool calls", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "edit file"),
      makeAssistantWithToolCall("a1", "tc1", "edit", {
        input: largeContent,
      }),
      makeToolResultMessage("tc1", "applied edit"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    expect(result.compactedCount).toBe(1);
  });

  it("compacts old read tool results", () => {
    const readContent = makeHashlineReadContent("src/math.ts");
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      makeAssistantWithToolCall("a1", "tc1", "read", {
        path: "src/math.ts",
      }),
      makeReadResultMessage("tc1", readContent),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minResultTokens: 100,
    });

    const compactedRead = result.messages[2]!;
    expect(result.compactedCount).toBe(1);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(compactedRead.toolCallId).toBe("tc1");
    expect(compactedRead.content).toContain("[compacted read result]");
    expect(compactedRead.content).toContain("src/math.ts");
    expect(compactedRead.content).toContain("#1234abcd");
    expect(compactedRead.meta?.["compacted"]).toMatchObject({
      compacted: "read-result",
      tool: "read",
      path: "src/math.ts",
      hash: "1234abcd",
    });
    // details should have one entry for "read"
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.toolName).toBe("read");
    expect(result.details[0]!.compactedCount).toBe(1);
    expect(result.details[0]!.tokensSaved).toBeGreaterThan(0);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatchObject({
      messageId: "tr-tc1",
      messageIndex: 2,
      turn: 1,
      role: "tool",
      kind: "tool_result",
      toolName: "read",
      toolCallId: "tc1",
      path: "src/math.ts",
    });
  });

  it("preserves recent read tool results", () => {
    const readContent = makeHashlineReadContent("src/math.ts");
    const messages: Message[] = [
      makeUserMessage("u1", "read first file"),
      makeAssistantWithToolCall("a1", "tc1", "read", {
        path: "src/math.ts",
      }),
      makeReadResultMessage("tc1", readContent),
      makeUserMessage("u2", "read recent file"),
      makeAssistantWithToolCall("a2", "tc2", "read", {
        path: "src/recent.ts",
      }),
      makeReadResultMessage("tc2", makeHashlineReadContent("src/recent.ts")),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1,
      minResultTokens: 100,
    });

    expect(result.compactedCount).toBe(1);
    expect(result.messages[2]!.content).toContain("[compacted read result]");
    expect(result.messages[5]!.content).toBe(messages[5]!.content);
  });

  it("skips failed read tool results", () => {
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      makeAssistantWithToolCall("a1", "tc1", "read", {
        path: "src/math.ts",
      }),
      makeReadResultMessage("tc1", makeHashlineReadContent("src/math.ts"), {
        isError: true,
      }),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minResultTokens: 100,
    });

    expect(result.compactedCount).toBe(0);
  });

  it("skips recent read results (in recent assistant turns)", () => {
    const readContent = makeHashlineReadContent("src/old.ts");
    const messages: Message[] = [
      makeUserMessage("u1", "read"),
      makeAssistantWithToolCall("a1", "tc1", "read", { path: "src/old.ts" }),
      makeReadResultMessage("tc1", readContent),
      // Second turn - this is the most recent assistant turn
      makeUserMessage("u2", "read another"),
      makeAssistantWithToolCall("a2", "tc2", "read", { path: "src/new.ts" }),
      makeReadResultMessage("tc2", makeHashlineReadContent("src/new.ts")),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1,
      minResultTokens: 100,
    });

    // Only the old read should be compacted
    expect(result.compactedCount).toBe(1);
    expect(result.messages[2]!.content).toContain("[compacted read result]");
    // Recent read should be preserved
    expect(result.messages[5]!.content).not.toContain("[compacted");
  });

  it("compacts both write tool calls and read results", () => {
    const largeContent = makeLargeCodeContent();
    const readContent = makeHashlineReadContent("src/file.ts");
    const messages: Message[] = [
      makeUserMessage("u1", "write and read"),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-w",
            name: "write",
            arguments: { path: "a.ts", content: largeContent },
          },
          { id: "tc-r", name: "read", arguments: { path: "src/file.ts" } },
        ],
        createdAt: new Date().toISOString(),
      },
      makeToolResultMessage("tc-w", "wrote 4000 bytes"),
      makeReadResultMessage("tc-r", readContent),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
      minResultTokens: 100,
    });

    expect(result.compactedCount).toBe(2);
    expect(result.tokensSaved).toBeGreaterThan(0);
    // Both write args and read result should be compacted
    expect(isCompacted(result.messages[1]!)).toBe(true);
    expect(result.messages[3]!.content).toContain("[compacted read result]");
    // details should have one entry for "write" and one for "read"
    const detailsByTool = new Map(result.details.map((d) => [d.toolName, d]));
    expect(detailsByTool.get("write")!.compactedCount).toBe(1);
    expect(detailsByTool.get("write")!.tokensSaved).toBeGreaterThan(0);
    expect(detailsByTool.get("read")!.compactedCount).toBe(1);
    expect(detailsByTool.get("read")!.tokensSaved).toBeGreaterThan(0);
    expect(result.details.reduce((sum, d) => sum + d.compactedCount, 0)).toBe(
      result.compactedCount,
    );
    expect(result.details.reduce((sum, d) => sum + d.tokensSaved, 0)).toBe(
      result.tokensSaved,
    );
  });

  it("mixed: write compacted, read skipped (too small)", () => {
    const largeContent = makeLargeCodeContent();
    const tinyReadContent = "small file content";
    const messages: Message[] = [
      makeUserMessage("u1", "write and read"),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-w",
            name: "write",
            arguments: { path: "a.ts", content: largeContent },
          },
          { id: "tc-r", name: "read", arguments: { path: "src/small.ts" } },
        ],
        createdAt: new Date().toISOString(),
      },
      makeToolResultMessage("tc-w", "wrote 4000 bytes"),
      makeReadResultMessage("tc-r", tinyReadContent),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
      minResultTokens: 100,
    });

    // Only write should be compacted; read is too small
    expect(result.compactedCount).toBe(1);
    expect(isCompacted(result.messages[1]!)).toBe(true);
    expect(result.messages[3]!.content).toBe(tinyReadContent);
    // details should only have "write"
    expect(result.details).toHaveLength(1);
    expect(result.details[0]!.toolName).toBe("write");
    expect(result.details[0]!.compactedCount).toBe(1);
    expect(result.details[0]!.tokensSaved).toBeGreaterThan(0);
  });

  it("skips non-write/edit tools", () => {
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      makeAssistantWithToolCall("a1", "tc1", "read", {
        path: "foo.ts",
      }),
      makeToolResultMessage("tc1", "file content"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    expect(result.compactedCount).toBe(0);
  });

  it("isCompacted detects compacted messages", () => {
    const msg = makeAssistantWithToolCall("a1", "tc1", "write", {
      compacted: "code-production",
      tool: "write",
      path: "foo.ts",
    });
    expect(isCompacted(msg)).toBe(true);

    const normal = makeAssistantWithToolCall("a2", "tc2", "write", {
      path: "foo.ts",
      content: "data",
    });
    expect(isCompacted(normal)).toBe(false);
  });

  it("skips orphan tool call with no result", () => {
    // Assistant emits tool call but no tool result message follows
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: "x".repeat(4000),
      }),
      // No tool result for tc1 — orphan
      makeUserMessage("u2", "next message"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    // Orphan should NOT be compacted (no result = not safe to compact)
    expect(result.compactedCount).toBe(0);
  });

  it("is idempotent — compacting twice produces same result", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `  line ${i}`);
    const largeContent = lines.join("\n");
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote content"),
      makeUserMessage("u2", "next"),
      makeAssistantWithToolCall("a2", "tc2", "read", {
        path: "bar.ts",
      }),
      makeToolResultMessage("tc2", "file content"),
    ];

    const opts = { keepRecentAssistantMessages: 0, minArgTokens: 100 };
    const first = compactCodeProductions(messages, opts);
    const second = compactCodeProductions(first.messages, opts);

    // Second compaction should not re-compact already-compacted tool calls
    expect(first.compactedCount).toBe(1);
    expect(second.compactedCount).toBe(0);

    // Messages should be structurally identical after second pass
    expect(second.messages[1]!.toolCalls![0]!.arguments).toEqual(
      first.messages[1]!.toolCalls![0]!.arguments,
    );
  });

  it("handles multi tool call with partial eligibility", () => {
    // Assistant emits 3 tool calls: write (success), edit (failed), read
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "do multiple things"),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-write",
            name: "write",
            arguments: { path: "a.ts", content: largeContent },
          },
          { id: "tc-edit", name: "edit", arguments: { input: largeContent } },
          { id: "tc-read", name: "read", arguments: { path: "b.ts" } },
        ],
        createdAt: new Date().toISOString(),
      },
      // write succeeds
      makeToolResultMessage("tc-write", "wrote file"),
      // edit fails
      {
        id: "tr-tc-edit",
        role: "tool",
        toolCallId: "tc-edit",
        toolName: "edit",
        content: "hash mismatch error",
        createdAt: new Date().toISOString(),
        meta: { isError: true },
      },
      // read succeeds
      makeToolResultMessage("tc-read", "file content"),
      // Next turn to push a1 out of recent window
      makeUserMessage("u2", "next"),
      makeAssistantWithToolCall("a2", "tc2", "read", { path: "c.ts" }),
      makeToolResultMessage("tc2", "content"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1, // protect only a2
      minArgTokens: 100,
    });

    // Only tc-write should be compacted (success + write/edit + large args)
    // tc-edit is failed, tc-read is not write/edit
    expect(result.compactedCount).toBe(1);

    // Verify only write was compacted
    const a1ToolCalls = result.messages[1]!.toolCalls!;
    expect(
      isCompacted({ ...result.messages[1]!, toolCalls: [a1ToolCalls[0]!] }),
    ).toBe(true);
    expect(a1ToolCalls[1]!.arguments).toEqual({ input: largeContent }); // edit unchanged
    expect(a1ToolCalls[2]!.arguments).toEqual({ path: "b.ts" }); // read unchanged
  });

  it("handles arguments as string and as object equally", () => {
    const largeJson = JSON.stringify({
      path: "foo.ts",
      content: makeLargeCodeContent(),
    });
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", largeJson), // string args
      makeToolResultMessage("tc1", "wrote"),
      makeUserMessage("u2", "next"),
      makeAssistantWithToolCall("a2", "tc2", "read", { path: "b.ts" }),
      makeToolResultMessage("tc2", "content"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1,
      minArgTokens: 100,
    });

    // String arguments should be compacted just like object arguments
    expect(result.compactedCount).toBe(1);
    expect(isCompacted(result.messages[1]!)).toBe(true);
  });

  it("preserves rawArguments for recovery", () => {
    const largeContent = makeLargeCodeContent();
    const originalArgs = { path: "foo.ts", content: largeContent };
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", originalArgs),
      makeToolResultMessage("tc1", "wrote"),
      makeUserMessage("u2", "next"),
      makeAssistantWithToolCall("a2", "tc2", "read", { path: "b.ts" }),
      makeToolResultMessage("tc2", "content"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 1,
      minArgTokens: 100,
    });

    const compacted = result.messages[1]!.toolCalls![0]!;
    // rawArguments should contain the original JSON string
    expect(compacted.rawArguments).toBeDefined();
    expect(typeof compacted.rawArguments).toBe("string");
    expect(JSON.parse(compacted.rawArguments!)).toEqual(originalArgs);

    // arguments should be the summary, not the original
    expect((compacted.arguments as any).compacted).toBe("code-production");
  });

  it("details aggregates correctly across multiple strategies", () => {
    const largeWriteContent = makeLargeCodeContent(300);
    const largeEditContent = makeLargeCodeContent(250);
    const readContent = makeHashlineReadContent("src/big.ts", 300);
    const messages: Message[] = [
      makeUserMessage("u1", "do stuff"),
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc-w1",
            name: "write",
            arguments: { path: "a.ts", content: largeWriteContent },
          },
          {
            id: "tc-w2",
            name: "write",
            arguments: { path: "b.ts", content: largeWriteContent },
          },
          { id: "tc-e1", name: "edit", arguments: { input: largeEditContent } },
          { id: "tc-r1", name: "read", arguments: { path: "src/big.ts" } },
        ],
        createdAt: new Date().toISOString(),
      },
      makeToolResultMessage("tc-w1", "wrote a.ts"),
      makeToolResultMessage("tc-w2", "wrote b.ts"),
      makeToolResultMessage("tc-e1", "applied edit"),
      makeReadResultMessage("tc-r1", readContent),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
      minResultTokens: 100,
    });

    expect(result.compactedCount).toBe(4);
    expect(result.tokensSaved).toBeGreaterThan(0);

    const detailsByTool = new Map(result.details.map((d) => [d.toolName, d]));
    // write: 2 compacted (tc-w1, tc-w2)
    expect(detailsByTool.get("write")!.compactedCount).toBe(2);
    expect(detailsByTool.get("write")!.tokensSaved).toBeGreaterThan(0);
    // edit: 1 compacted (tc-e1)
    expect(detailsByTool.get("edit")!.compactedCount).toBe(1);
    expect(detailsByTool.get("edit")!.tokensSaved).toBeGreaterThan(0);
    // read: 1 compacted (tc-r1)
    expect(detailsByTool.get("read")!.compactedCount).toBe(1);
    expect(detailsByTool.get("read")!.tokensSaved).toBeGreaterThan(0);

    // Sum of detail counts/tokens should equal totals
    const totalDetailCount = result.details.reduce(
      (sum, d) => sum + d.compactedCount,
      0,
    );
    const totalDetailTokens = result.details.reduce(
      (sum, d) => sum + d.tokensSaved,
      0,
    );
    expect(totalDetailCount).toBe(result.compactedCount);
    expect(totalDetailTokens).toBe(result.tokensSaved);
  });

  it("details is empty when nothing compacted", () => {
    const messages: Message[] = [
      makeUserMessage("u1", "nothing big"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: "tiny",
      }),
      makeToolResultMessage("tc1", "wrote 5 bytes"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 800,
    });

    expect(result.compactedCount).toBe(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.details).toHaveLength(0);
  });
});

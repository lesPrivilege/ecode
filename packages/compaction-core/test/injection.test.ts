import { describe, it, expect } from "vitest";
import {
  compactCodeProductions,
  isCompacted,
  DEFAULT_TOOL_COMPACTION_STRATEGIES,
  defaultMatchStrategy,
  hashlineExtractor,
  pathLineCountExtractor,
  type ToolCompactionStrategy,
  type StrategyMatcher,
  type PathHashExtractor,
  type ReadResultSummary,
} from "../src/compaction.js";
import type { Message } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures (mirror the ported test helpers)
// ---------------------------------------------------------------------------

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

function makeToolResultMessage(
  toolCallId: string,
  content: string,
  toolName = "write",
): Message {
  return {
    id: `tr-${toolCallId}`,
    role: "tool",
    toolCallId,
    toolName,
    content,
    createdAt: new Date().toISOString(),
  };
}

function makeReadResultMessage(toolCallId: string, content: string): Message {
  return {
    id: `tr-${toolCallId}`,
    role: "tool",
    toolCallId,
    toolName: "read",
    content,
    createdAt: new Date().toISOString(),
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

function makeLargeCodeContent(lineCount = 200): string {
  return Array.from(
    { length: lineCount },
    (_, i) => `export const value${i} = ${i};`,
  ).join("\n");
}

function makeHashlineReadContent(path: string, lineCount = 200): string {
  const lines = Array.from(
    { length: lineCount },
    (_, i) => `${i + 1}:export const value${i} = ${i};`,
  );
  return `¶${path}#1234abcd\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Seam #1: injectable `strategies`
// ---------------------------------------------------------------------------

describe("injection seam #1: strategies", () => {
  it("uses a custom strategy set for a tool name the default set ignores", () => {
    const largeContent = makeLargeCodeContent();
    // "note" is not in DEFAULT_TOOL_COMPACTION_STRATEGIES.
    const messages: Message[] = [
      makeUserMessage("u1", "take a note"),
      makeAssistantWithToolCall("a1", "tc1", "note", {
        path: "n.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "noted", "note"),
    ];

    // Baseline: default strategies do NOT compact "note".
    const baseline = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    expect(baseline.compactedCount).toBe(0);

    // A custom strategy set that DOES handle "note" as a code production.
    const noteStrategy: ToolCompactionStrategy = {
      toolName: "note",
      compactToolCall: ({ toolCall, toolResult, options }) => {
        const args =
          typeof toolCall.arguments === "string"
            ? toolCall.arguments
            : JSON.stringify(toolCall.arguments);
        const rawTokens = Math.ceil(args.length / 4);
        if (!toolResult || toolResult.isError) return null;
        if (rawTokens < options.minArgTokens) return null;
        const summary = {
          compacted: "code-production" as const,
          tool: "write" as const,
          path: "n.ts",
          chars: args.length,
          lines: 1,
          head: "note",
          result: toolResult.content.slice(0, 200),
        };
        const compactedTokens = Math.ceil(JSON.stringify(summary).length / 4);
        return {
          toolCall: { ...toolCall, arguments: summary, rawArguments: args },
          summary,
          rawTokens,
          compactedTokens,
          tokensSaved: rawTokens - compactedTokens,
        };
      },
    };

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      { strategies: [noteStrategy] },
    );

    expect(result.compactedCount).toBe(1);
    expect(isCompacted(result.messages[1]!)).toBe(true);
    expect(result.details[0]!.toolName).toBe("note");
  });

  it("a custom set that omits a tool disables compaction for that tool", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    // Inject a strategy set containing ONLY a read strategy — "write" is absent.
    const readOnly = DEFAULT_TOOL_COMPACTION_STRATEGIES.filter(
      (s) => s.toolName === "read",
    );

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      { strategies: readOnly },
    );

    // Default would compact this write; with our custom set it must not.
    expect(result.compactedCount).toBe(0);
  });

  it("omitting injection reproduces default-strategy behavior exactly", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];
    const opts = { keepRecentAssistantMessages: 0, minArgTokens: 100 };

    const withoutInjection = compactCodeProductions(messages, opts);
    const withExplicitDefault = compactCodeProductions(messages, opts, {
      strategies: DEFAULT_TOOL_COMPACTION_STRATEGIES,
    });

    expect(withExplicitDefault.compactedCount).toBe(
      withoutInjection.compactedCount,
    );
    expect(withExplicitDefault.messages[1]!.toolCalls![0]!.arguments).toEqual(
      withoutInjection.messages[1]!.toolCalls![0]!.arguments,
    );
  });
});

// ---------------------------------------------------------------------------
// Seam #2: injectable tool-name matching
// ---------------------------------------------------------------------------

describe("injection seam #2: matchStrategy", () => {
  it("default matcher does an exact-name lookup (miss on case difference)", () => {
    const largeContent = makeLargeCodeContent();
    // Tool name "WRITE" (uppercase) does not exactly match "write".
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "WRITE", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes", "WRITE"),
    ];

    const result = compactCodeProductions(messages, {
      keepRecentAssistantMessages: 0,
      minArgTokens: 100,
    });
    // Exact-match default cannot resolve "WRITE" → not compacted.
    expect(result.compactedCount).toBe(0);
  });

  it("a case-insensitive matcher lets a differently-cased tool name compact", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "WRITE", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes", "WRITE"),
    ];

    const caseInsensitiveMatcher: StrategyMatcher = (strategies, toolName) =>
      strategies.find(
        (s) => s.toolName.toLowerCase() === toolName.toLowerCase(),
      );

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      { matchStrategy: caseInsensitiveMatcher },
    );

    expect(result.compactedCount).toBe(1);
    expect(isCompacted(result.messages[1]!)).toBe(true);
    // The diff/detail should record the tool name as it appeared on the call.
    expect(result.details[0]!.toolName).toBe("WRITE");
  });

  it("the matcher is actually consulted (custom matcher can force a miss)", () => {
    const largeContent = makeLargeCodeContent();
    const messages: Message[] = [
      makeUserMessage("u1", "write file"),
      makeAssistantWithToolCall("a1", "tc1", "write", {
        path: "foo.ts",
        content: largeContent,
      }),
      makeToolResultMessage("tc1", "wrote 4000 bytes"),
    ];

    // A matcher that always returns undefined must disable all compaction,
    // proving the injected matcher (not the internal Map) is what's used.
    const neverMatch: StrategyMatcher = () => undefined;

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minArgTokens: 100 },
      { matchStrategy: neverMatch },
    );

    expect(result.compactedCount).toBe(0);
  });

  it("defaultMatchStrategy resolves exact names and misses others", () => {
    expect(
      defaultMatchStrategy(DEFAULT_TOOL_COMPACTION_STRATEGIES, "write")
        ?.toolName,
    ).toBe("write");
    expect(
      defaultMatchStrategy(DEFAULT_TOOL_COMPACTION_STRATEGIES, "nope"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Seam #3: injectable path/hash extraction
// ---------------------------------------------------------------------------

describe("injection seam #3: pathHashExtractor", () => {
  it("a custom extractor overrides the path/hash in the read summary", () => {
    const readContent = makeHashlineReadContent("src/math.ts");
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      makeAssistantWithToolCall("a1", "tc1", "read", { path: "src/math.ts" }),
      makeReadResultMessage("tc1", readContent),
    ];

    // Custom extractor ignores the hashline and reports its own values.
    const customExtractor: PathHashExtractor = () => ({
      path: "custom/override.ts",
      hash: "deadbeef",
    });

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minResultTokens: 100 },
      { pathHashExtractor: customExtractor },
    );

    expect(result.compactedCount).toBe(1);
    const summary = result.messages[2]!.meta?.["compacted"] as ReadResultSummary;
    expect(summary.path).toBe("custom/override.ts");
    expect(summary.hash).toBe("deadbeef");
    // The rendered content must reflect the injected extractor, not the hashline.
    expect(result.messages[2]!.content).toContain("custom/override.ts");
    expect(result.messages[2]!.content).toContain("#deadbeef");
    expect(result.messages[2]!.content).not.toContain("src/math.ts");
    expect(result.messages[2]!.content).not.toContain("#1234abcd");
  });

  it("the built-in hashlineExtractor still parses ¶path#hash by default", () => {
    expect(hashlineExtractor("¶src/a.ts#0011aabb\nrest")).toEqual({
      path: "src/a.ts",
      hash: "0011aabb",
    });
    expect(hashlineExtractor("no hashline here")).toBeUndefined();
  });

  it("pathLineCountExtractor degrades to path-only (no hash) on non-hashline reads", () => {
    // Content without a hashline header — degrade path from a `path:` label.
    const nonHashlineContent = [
      "path: src/plain.ts",
      ...Array.from({ length: 200 }, (_, i) => `line ${i}`),
    ].join("\n");
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      // No path in args and no meta.sourcePath, so the extractor is the only source.
      makeAssistantWithToolCall("a1", "tc1", "read", {}),
      makeReadResultMessage("tc1", nonHashlineContent),
    ];

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minResultTokens: 100 },
      { pathHashExtractor: pathLineCountExtractor },
    );

    expect(result.compactedCount).toBe(1);
    const summary = result.messages[2]!.meta?.["compacted"] as ReadResultSummary;
    expect(summary.path).toBe("src/plain.ts");
    expect(summary.hash).toBeUndefined();
    // Degraded summary keeps the line/char counts.
    expect(summary.lines).toBe(201);
    expect(summary.chars).toBe(nonHashlineContent.length);
    // Rendered content shows path + line count but no hash marker.
    expect(result.messages[2]!.content).toContain("src/plain.ts");
    expect(result.messages[2]!.content).toContain("201 lines");
    expect(result.messages[2]!.content).not.toContain("#");
  });

  it("pathLineCountExtractor falls back to args path when it cannot parse a header", () => {
    // Body has no recognizable path header; extractor returns undefined,
    // so the tool-call args path wins — degrade to path + line count.
    const bodyOnly = Array.from(
      { length: 200 },
      (_, i) => `plain line ${i}`,
    ).join("\n");
    const messages: Message[] = [
      makeUserMessage("u1", "read file"),
      makeAssistantWithToolCall("a1", "tc1", "read", { path: "src/args.ts" }),
      makeReadResultMessage("tc1", bodyOnly),
    ];

    const result = compactCodeProductions(
      messages,
      { keepRecentAssistantMessages: 0, minResultTokens: 100 },
      { pathHashExtractor: pathLineCountExtractor },
    );

    expect(result.compactedCount).toBe(1);
    const summary = result.messages[2]!.meta?.["compacted"] as ReadResultSummary;
    expect(summary.path).toBe("src/args.ts");
    expect(summary.hash).toBeUndefined();
  });
});

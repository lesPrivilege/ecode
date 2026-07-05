import type { Message, ToolCall, ToolResult } from "./types.js";

/**
 * Summary produced when a code-production tool call is compacted.
 */
export interface CodeProductionSummary {
  compacted: "code-production";
  tool: "write" | "edit";
  path?: string;
  chars: number;
  lines: number;
  head: string;
  tail?: string;
  result: string;
}

/**
 * Summary produced when an old read tool result is compacted.
 */
export interface ReadResultSummary {
  compacted: "read-result";
  tool: "read";
  path?: string;
  hash?: string;
  chars: number;
  lines: number;
}

/**
 * Summary produced when an old bash tool result is compacted.
 */
export interface BashResultSummary {
  compacted: "bash-result";
  tool: "bash";
  command?: string;
  chars: number;
  lines: number;
  exitCode?: number;
  stderrLines: number;
}

/**
 * Summary produced when an old search tool result is compacted.
 */
export interface SearchResultSummary {
  compacted: "search-result";
  tool: "search";
  pattern?: string;
  paths?: string[];
  matchCount: number;
  fileCount: number;
  chars: number;
  lines: number;
  preview?: string;
}

/**
 * Summary produced when an old find tool result is compacted.
 */
export interface FindResultSummary {
  compacted: "find-result";
  tool: "find";
  patterns?: string[];
  fileCount: number;
  chars: number;
  lines: number;
  preview?: string;
}

/**
 * Options for turn-level compaction.
 */
export interface CompactionOptions {
  /** Number of recent assistant messages to preserve in full (default: 3) */
  keepRecentAssistantMessages: number;
  /** Minimum token estimate for tool arguments to be eligible (default: 800) */
  minArgTokens: number;
  /** Minimum token estimate for read results to be eligible (default: 200) */
  minResultTokens: number;
}

export const DEFAULT_COMPACTION_OPTIONS: CompactionOptions = {
  keepRecentAssistantMessages: 3,
  minArgTokens: 800,
  minResultTokens: 200,
};

/**
 * Extracts a `{ path, hash }` pair from a tool-result body.
 *
 * Injection seam (#3): the built-in `hashlineExtractor` understands the
 * `¶path#hash` hashline header used by the original harness's read output.
 * Harnesses that do not emit hashlines can inject their own extractor, or
 * fall back to {@link pathLineCountExtractor}, which degrades to "path only"
 * (line/char counts are always computed by the summariser from the raw body).
 *
 * Returning `undefined` (or a result with no `path`) lets the caller fall
 * through to the tool-call arguments / message meta for the path.
 */
export type PathHashExtractor = (
  content: string,
) => { path?: string; hash?: string } | undefined;

interface ToolCallCompactionInput {
  toolCall: ToolCall;
  toolResult: ToolResult | undefined;
  options: CompactionOptions;
}

interface ToolResultCompactionInput {
  message: Message;
  toolCall: ToolCall;
  options: CompactionOptions;
  /**
   * Path/hash extractor threaded from {@link compactCodeProductions}.
   * Optional so custom strategies that do not need it can ignore it; the
   * built-in read strategy defaults to {@link hashlineExtractor} when absent.
   */
  pathHashExtractor?: PathHashExtractor;
}

interface ToolCallCompactionOutput {
  toolCall: ToolCall;
  summary: CodeProductionSummary;
  rawTokens: number;
  compactedTokens: number;
  tokensSaved: number;
}

interface ToolResultCompactionOutput {
  message: Message;
  summary: ReadResultSummary | BashResultSummary | SearchResultSummary | FindResultSummary;
  rawTokens: number;
  compactedTokens: number;
  tokensSaved: number;
}

export interface ToolCompactionStrategy {
  toolName: string;
  compactToolCall?(
    input: ToolCallCompactionInput,
  ): ToolCallCompactionOutput | null;
  compactToolResult?(
    input: ToolResultCompactionInput,
  ): ToolResultCompactionOutput | null;
}

/**
 * Resolves a strategy for a given tool name from the configured strategy set.
 *
 * Injection seam (#2): {@link compactCodeProductions} delegates tool-name
 * matching to a function of this shape. The built-in
 * {@link defaultMatchStrategy} does an exact-name lookup (last strategy for a
 * given name wins, matching the original Map-based behavior). Harnesses whose
 * tool names differ (e.g. "Write" vs "write", or "fs.read") can inject a
 * matcher that normalises or prefix-matches instead.
 */
export type StrategyMatcher = (
  strategies: ToolCompactionStrategy[],
  toolName: string,
) => ToolCompactionStrategy | undefined;

/**
 * Rough token estimate: ~4 chars per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extract path from tool call arguments if present.
 */
function extractPath(args: unknown): string | undefined {
  if (typeof args === "object" && args !== null && "path" in args) {
    return (args as Record<string, unknown>)["path"] as string | undefined;
  }
  return undefined;
}

/**
 * Parse tool call arguments if they arrived as a JSON string.
 */
function parseArguments(args: unknown): unknown {
  if (typeof args !== "string") {
    return args;
  }

  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/**
 * Get head/tail lines from content for the summary.
 */
function getHeadTail(
  content: string,
  maxLines: number = 5,
): { head: string; tail?: string } {
  const lines = content.split("\n");
  const head = lines.slice(0, maxLines).join("\n");
  const tail =
    lines.length > maxLines * 2 ? lines.slice(-maxLines).join("\n") : undefined;
  return { head, tail };
}

/**
 * Check if a message is an assistant message with tool calls.
 */
function isAssistantWithToolCalls(msg: Message): boolean {
  return (
    msg.role === "assistant" && !!msg.toolCalls && msg.toolCalls.length > 0
  );
}

function isToolResultError(msg: Message): boolean {
  return msg.meta?.["isError"] === true || msg.meta?.["is_error"] === true;
}

/**
 * Check if a tool call is eligible for compaction.
 *
 * Eligibility:
 * - tool result is success (not error)
 * - raw tool arguments exceed minArgTokens
 */
function isEligibleForCompaction(
  toolResult: ToolResult | undefined,
  argTokens: number,
  minArgTokens: number,
): boolean {
  // Must have a successful result
  if (!toolResult || toolResult.isError) {
    return false;
  }

  // Arguments must be large enough
  if (argTokens < minArgTokens) {
    return false;
  }

  return true;
}

/**
 * Build a CodeProductionSummary from a tool call and its result.
 */
function buildSummary(
  toolCall: ToolCall,
  toolResult: ToolResult,
): CodeProductionSummary {
  const args =
    typeof toolCall.arguments === "string"
      ? toolCall.arguments
      : JSON.stringify(toolCall.arguments);

  const parsedArgs = parseArguments(toolCall.arguments);
  const path = extractPath(parsedArgs);
  const parsedArgsRecord =
    typeof parsedArgs === "object" && parsedArgs !== null
      ? (parsedArgs as Record<string, unknown>)
      : undefined;
  const contentField =
    parsedArgsRecord?.["content"] ?? parsedArgsRecord?.["input"];

  const content = typeof contentField === "string" ? contentField : args;
  const { head, tail } = getHeadTail(content);

  return {
    compacted: "code-production",
    tool: toolCall.name as "write" | "edit",
    path,
    chars: args.length,
    lines: content.split("\n").length,
    head,
    tail,
    result: toolResult.content.slice(0, 200),
  };
}

/**
 * Built-in path/hash extractor for the `¶path#hash` hashline header.
 *
 * This is the exact behavior the original harness relied on: the first line
 * of a read result is `¶<path>#<8-hex-hash>`. Returns `undefined` when the
 * first line does not match, so the caller falls through to args/meta.
 */
export const hashlineExtractor: PathHashExtractor = (content) => {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^¶(.+)#([0-9a-f]{8})$/);
  if (!match) return undefined;
  return { path: match[1]!, hash: match[2]! };
};

/**
 * Built-in fallback extractor for harnesses that do not use hashlines.
 *
 * Degrades to "path only" (no hash). Line and char counts are computed
 * downstream by the summariser, so this extractor deliberately never reports
 * a hash. It recognises a couple of common leading-path conventions
 * (`path: <p>` or `==> <p> <==`) and otherwise returns `undefined`, letting
 * the caller resolve the path from tool-call arguments or message meta.
 */
export const pathLineCountExtractor: PathHashExtractor = (content) => {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const labelled = firstLine.match(/^\s*path:\s*(\S.*?)\s*$/i);
  if (labelled) return { path: labelled[1]! };
  const header = firstLine.match(/^==>\s*(\S.*?)\s*<==$/);
  if (header) return { path: header[1]! };
  return undefined;
};

function buildReadResultSummary(
  msg: Message,
  toolCall: ToolCall | undefined,
  pathHashExtractor: PathHashExtractor,
): ReadResultSummary {
  const content = msg.content ?? "";
  const parsedArgs = toolCall ? parseArguments(toolCall.arguments) : undefined;
  const extracted = pathHashExtractor(content);
  const path =
    extracted?.path ??
    extractPath(parsedArgs) ??
    (msg.meta?.["sourcePath"] as string | undefined);

  return {
    compacted: "read-result",
    tool: "read",
    path,
    hash: extracted?.hash,
    chars: content.length,
    lines: content.split("\n").length,
  };
}

function formatReadResultSummary(summary: ReadResultSummary): string {
  const path = summary.path ? ` ${summary.path}` : "";
  const hash = summary.hash ? `, #${summary.hash}` : "";
  return `[compacted read result]\nread${path} (${summary.lines} lines, ${summary.chars} chars${hash}). Re-run read if exact content is needed.`;
}

/**
 * Extract a string field from parsed tool call arguments.
 */
function extractStringField(
  args: unknown,
  field: string,
): string | undefined {
  if (typeof args === "object" && args !== null && field in args) {
    return (args as Record<string, unknown>)[field] as string | undefined;
  }
  return undefined;
}

/**
 * Extract the first and last lines from content for a preview.
 */
function getFirstLines(content: string, maxLines: number = 3): string {
  const lines = content.split("\n");
  return lines.slice(0, maxLines).join("\n");
}

function buildBashResultSummary(
  msg: Message,
  toolCall: ToolCall | undefined,
): BashResultSummary {
  const content = msg.content ?? "";
  const parsedArgs = toolCall ? parseArguments(toolCall.arguments) : undefined;
  const command = extractStringField(parsedArgs, "command");

  // Count stderr lines from meta if available
  const stderrLines = (msg.meta?.["stderrLines"] as number) ?? 0;

  // Try to extract exit code from meta
  const exitCode = msg.meta?.["exitCode"] as number | undefined;

  return {
    compacted: "bash-result",
    tool: "bash",
    command,
    chars: content.length,
    lines: content.split("\n").length,
    exitCode,
    stderrLines,
  };
}

function formatBashResultSummary(summary: BashResultSummary): string {
  const cmd = summary.command ? ` ${summary.command}` : "";
  const exit =
    summary.exitCode !== undefined ? `, exit=${summary.exitCode}` : "";
  const stderr =
    summary.stderrLines > 0
      ? `, stderr=${summary.stderrLines} lines`
      : "";
  return `[compacted bash result]\nbash${cmd} (${summary.lines} lines, ${summary.chars} chars${exit}${stderr}). Re-run command if exact output is needed.`;
}

function buildSearchResultSummary(
  msg: Message,
  toolCall: ToolCall | undefined,
): SearchResultSummary {
  const content = msg.content ?? "";
  const parsedArgs = toolCall ? parseArguments(toolCall.arguments) : undefined;
  const pattern = extractStringField(parsedArgs, "pattern");
  const pathsRaw = parsedArgs
    ? (parsedArgs as Record<string, unknown>)["paths"]
    : undefined;
  const paths = Array.isArray(pathsRaw)
    ? (pathsRaw as string[])
    : typeof pathsRaw === "string"
      ? [pathsRaw]
      : undefined;

  // Count matches: each non-empty line in search output is a match line
  const lines = content.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const matchCount = nonEmptyLines.length;

  // Count unique files from match lines (ripgrep format: "file:line:content")
  const fileSet = new Set<string>();
  for (const line of nonEmptyLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const secondColon = line.indexOf(":", colonIdx + 1);
      if (secondColon > colonIdx) {
        // Check if the part between first and second colon looks like a line number
        const between = line.slice(colonIdx + 1, secondColon);
        if (/^\d+$/.test(between)) {
          fileSet.add(line.slice(0, colonIdx));
        }
      }
    }
  }

  const preview = getFirstLines(content);

  return {
    compacted: "search-result",
    tool: "search",
    pattern,
    paths,
    matchCount,
    fileCount: fileSet.size,
    chars: content.length,
    lines: lines.length,
    preview,
  };
}

function formatSearchResultSummary(summary: SearchResultSummary): string {
  const pattern = summary.pattern ? ` "${summary.pattern}"` : "";
  const paths = summary.paths ? ` in ${summary.paths.join(", ")}` : "";
  const preview = summary.preview ? `\nPreview:\n${summary.preview}` : "";
  return `[compacted search result]\nsearch${pattern}${paths} (${summary.matchCount} matches in ${summary.fileCount} files, ${summary.lines} lines, ${summary.chars} chars). Re-run search if exact output is needed.${preview}`;
}

function buildFindResultSummary(
  msg: Message,
  toolCall: ToolCall | undefined,
): FindResultSummary {
  const content = msg.content ?? "";
  const parsedArgs = toolCall ? parseArguments(toolCall.arguments) : undefined;
  const pathsRaw = parsedArgs
    ? (parsedArgs as Record<string, unknown>)["paths"]
    : undefined;
  const patterns = Array.isArray(pathsRaw)
    ? (pathsRaw as string[])
    : typeof pathsRaw === "string"
      ? [pathsRaw]
      : undefined;

  // Count files: each non-empty line is a file path
  const lines = content.split("\n");
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const fileCount = nonEmptyLines.length;

  const preview = getFirstLines(content);

  return {
    compacted: "find-result",
    tool: "find",
    patterns,
    fileCount,
    chars: content.length,
    lines: lines.length,
    preview,
  };
}

function formatFindResultSummary(summary: FindResultSummary): string {
  const patterns = summary.patterns
    ? ` ${summary.patterns.join(", ")}`
    : "";
  const preview = summary.preview ? `\nPreview:\n${summary.preview}` : "";
  return `[compacted find result]\nfind${patterns} (${summary.fileCount} files, ${summary.lines} lines, ${summary.chars} chars). Re-run find if exact output is needed.${preview}`;
}

function compactCodeProductionToolCall({
  toolCall,
  toolResult,
  options,
}: ToolCallCompactionInput): ToolCallCompactionOutput | null {
  const args =
    typeof toolCall.arguments === "string"
      ? toolCall.arguments
      : JSON.stringify(toolCall.arguments);
  const argTokens = estimateTokens(args);

  if (!isEligibleForCompaction(toolResult, argTokens, options.minArgTokens)) {
    return null;
  }

  const summary = buildSummary(toolCall, toolResult!);
  const summaryTokens = estimateTokens(JSON.stringify(summary));
  if (summaryTokens >= argTokens) {
    return null;
  }

  return {
    toolCall: {
      ...toolCall,
      arguments: summary,
      rawArguments: args,
    },
    summary,
    rawTokens: argTokens,
    compactedTokens: summaryTokens,
    tokensSaved: argTokens - summaryTokens,
  };
}

function compactReadToolResult({
  message,
  toolCall,
  options,
  pathHashExtractor,
}: ToolResultCompactionInput): ToolResultCompactionOutput | null {
  if (isToolResultError(message)) {
    return null;
  }

  const content = message.content ?? "";
  const resultTokens = estimateTokens(content);
  if (resultTokens < options.minResultTokens) {
    return null;
  }

  const summary = buildReadResultSummary(
    message,
    toolCall,
    pathHashExtractor ?? hashlineExtractor,
  );
  const summaryContent = formatReadResultSummary(summary);
  const summaryTokens = estimateTokens(summaryContent);
  if (summaryTokens >= resultTokens) {
    return null;
  }

  return {
    message: {
      ...message,
      content: summaryContent,
      meta: {
        ...message.meta,
        compacted: summary,
      },
    },
    summary,
    rawTokens: resultTokens,
    compactedTokens: summaryTokens,
    tokensSaved: resultTokens - summaryTokens,
  };
}

function compactBashToolResult({
  message,
  toolCall,
  options,
}: ToolResultCompactionInput): ToolResultCompactionOutput | null {
  if (isToolResultError(message)) {
    return null;
  }

  const content = message.content ?? "";
  const resultTokens = estimateTokens(content);
  if (resultTokens < options.minResultTokens) {
    return null;
  }

  const summary = buildBashResultSummary(message, toolCall);
  const summaryContent = formatBashResultSummary(summary);
  const summaryTokens = estimateTokens(summaryContent);
  if (summaryTokens >= resultTokens) {
    return null;
  }

  return {
    message: {
      ...message,
      content: summaryContent,
      meta: {
        ...message.meta,
        compacted: summary,
      },
    },
    summary,
    rawTokens: resultTokens,
    compactedTokens: summaryTokens,
    tokensSaved: resultTokens - summaryTokens,
  };
}

function compactSearchToolResult({
  message,
  toolCall,
  options,
}: ToolResultCompactionInput): ToolResultCompactionOutput | null {
  if (isToolResultError(message)) {
    return null;
  }

  const content = message.content ?? "";
  const resultTokens = estimateTokens(content);
  if (resultTokens < options.minResultTokens) {
    return null;
  }

  const summary = buildSearchResultSummary(message, toolCall);
  const summaryContent = formatSearchResultSummary(summary);
  const summaryTokens = estimateTokens(summaryContent);
  if (summaryTokens >= resultTokens) {
    return null;
  }

  return {
    message: {
      ...message,
      content: summaryContent,
      meta: {
        ...message.meta,
        compacted: summary,
      },
    },
    summary,
    rawTokens: resultTokens,
    compactedTokens: summaryTokens,
    tokensSaved: resultTokens - summaryTokens,
  };
}

function compactFindToolResult({
  message,
  toolCall,
  options,
}: ToolResultCompactionInput): ToolResultCompactionOutput | null {
  if (isToolResultError(message)) {
    return null;
  }

  const content = message.content ?? "";
  const resultTokens = estimateTokens(content);
  if (resultTokens < options.minResultTokens) {
    return null;
  }

  const summary = buildFindResultSummary(message, toolCall);
  const summaryContent = formatFindResultSummary(summary);
  const summaryTokens = estimateTokens(summaryContent);
  if (summaryTokens >= resultTokens) {
    return null;
  }

  return {
    message: {
      ...message,
      content: summaryContent,
      meta: {
        ...message.meta,
        compacted: summary,
      },
    },
    summary,
    rawTokens: resultTokens,
    compactedTokens: summaryTokens,
    tokensSaved: resultTokens - summaryTokens,
  };
}

export const DEFAULT_TOOL_COMPACTION_STRATEGIES: ToolCompactionStrategy[] = [
  {
    toolName: "write",
    compactToolCall: compactCodeProductionToolCall,
  },
  {
    toolName: "edit",
    compactToolCall: compactCodeProductionToolCall,
  },
  {
    toolName: "read",
    compactToolResult: compactReadToolResult,
  },
  {
    toolName: "bash",
    compactToolResult: compactBashToolResult,
  },
  {
    toolName: "search",
    compactToolResult: compactSearchToolResult,
  },
  {
    toolName: "find",
    compactToolResult: compactFindToolResult,
  },
];

/**
 * Default tool-name matcher (injection seam #2).
 *
 * Exact-name lookup. Builds a Map so the last strategy registered for a given
 * tool name wins — identical to the original `new Map(strategies.map(...))`
 * behavior that `compactCodeProductions` used internally.
 */
export const defaultMatchStrategy: StrategyMatcher = (strategies, toolName) => {
  const map = new Map(
    strategies.map((strategy) => [strategy.toolName, strategy]),
  );
  return map.get(toolName);
};

/**
 * Per-tool compaction detail: how many items were compacted and tokens saved
 * for each strategy/tool.
 */
export interface StrategyCompactionDetail {
  toolName: string;
  compactedCount: number;
  tokensSaved: number;
}

export interface CompactionDiffEntry {
  messageId: string;
  messageIndex: number;
  turn: number;
  role: "assistant" | "tool";
  kind: "tool_call" | "tool_result";
  toolName: "write" | "edit" | "read" | string;
  toolCallId: string;
  path?: string;
  rawTokens: number;
  compactedTokens: number;
  tokensSaved: number;
}

/**
 * Result of compaction.
 */
export interface CompactionResult {
  /** Messages with compacted entries (new array, original untouched) */
  messages: Message[];
  /** Number of tool calls/results that were compacted */
  compactedCount: number;
  /** Estimated tokens saved */
  tokensSaved: number;
  /** Per-tool breakdown of compaction: each strategy's compacted count and tokens saved */
  details: StrategyCompactionDetail[];
  /** Per-message/token diff for send-time projection observability */
  diffs: CompactionDiffEntry[];
}

/**
 * Injectable seams for {@link compactCodeProductions}.
 *
 * All three are optional and default to the original harness behavior, so
 * existing callers/tests are unaffected unless they opt into a custom set.
 */
export interface CompactionInjection {
  /**
   * Seam #1 — the tool compaction strategy set (replaces the hardcoded
   * registry). Defaults to {@link DEFAULT_TOOL_COMPACTION_STRATEGIES}.
   */
  strategies?: ToolCompactionStrategy[];
  /**
   * Seam #2 — how a tool name is matched to a strategy. Defaults to
   * {@link defaultMatchStrategy} (exact-name lookup).
   */
  matchStrategy?: StrategyMatcher;
  /**
   * Seam #3 — how `{ path, hash }` is extracted from a read result body.
   * Defaults to {@link hashlineExtractor} (the `¶path#hash` format).
   */
  pathHashExtractor?: PathHashExtractor;
}

/**
 * Compact old code-production tool calls and read/bash/search/find results in a conversation.
 *
 * Replaces large tool call arguments with compact summaries.
 * Preserves the last N assistant messages in full.
 * - Skips small arguments (< minArgTokens)
 * - Reports compacted count and estimated tokens saved
 *
 * Three behaviors are injectable via {@link CompactionInjection} (strategy set,
 * tool-name matching, path/hash extraction). All default to the original
 * behavior, so omitting `injection` reproduces the pre-refactor output exactly.
 */
export function compactCodeProductions(
  messages: Message[],
  options?: Partial<CompactionOptions>,
  injection?: CompactionInjection,
): CompactionResult {
  const opts = { ...DEFAULT_COMPACTION_OPTIONS, ...options };
  const strategies =
    injection?.strategies ?? DEFAULT_TOOL_COMPACTION_STRATEGIES;
  const matchStrategy = injection?.matchStrategy ?? defaultMatchStrategy;
  const pathHashExtractor =
    injection?.pathHashExtractor ?? hashlineExtractor;

  // Find assistant message indices to determine "recent" messages
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // The last N assistant messages are "recent" and should not be compacted
  const recentCutoff =
    opts.keepRecentAssistantMessages <= 0
      ? Number.POSITIVE_INFINITY
      : assistantIndices.length > opts.keepRecentAssistantMessages
        ? assistantIndices[
            assistantIndices.length - opts.keepRecentAssistantMessages
          ]!
        : 0;

  // Build a map of tool call id → assistant index
  const toolCallMap = new Map<
    string,
    { toolCall: ToolCall; assistantIdx: number }
  >();
  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx]!;
    if (!isAssistantWithToolCalls(msg)) continue;
    for (const toolCall of msg.toolCalls!) {
      toolCallMap.set(toolCall.id, { toolCall, assistantIdx: idx });
    }
  }

  // Build a map of tool call id → tool result
  const toolResultMap = new Map<string, ToolResult>();
  for (const msg of messages) {
    if (msg.role === "tool" && msg.toolCallId) {
      toolResultMap.set(msg.toolCallId, {
        toolCallId: msg.toolCallId,
        toolName: msg.toolName ?? "",
        content: msg.content ?? "",
        isError: isToolResultError(msg),
      });
    }
  }

  // Per-tool tracking: toolName → { compactedCount, tokensSaved }
  const detailMap = new Map<
    string,
    { compactedCount: number; tokensSaved: number }
  >();
  function recordCompaction(toolName: string, saved: number) {
    let entry = detailMap.get(toolName);
    if (!entry) {
      entry = { compactedCount: 0, tokensSaved: 0 };
      detailMap.set(toolName, entry);
    }
    entry.compactedCount++;
    entry.tokensSaved += saved;
  }

  let compactedCount = 0;
  let tokensSaved = 0;
  const diffs: CompactionDiffEntry[] = [];

  const result = messages.map((msg, idx) => {
    if (msg.role === "tool" && msg.toolCallId) {
      const toolCallInfo = toolCallMap.get(msg.toolCallId);
      if (!toolCallInfo) return msg;
      if (toolCallInfo.assistantIdx >= recentCutoff) return msg;

      const strategy = matchStrategy(strategies, msg.toolName ?? "");
      const output = strategy?.compactToolResult?.({
        message: msg,
        toolCall: toolCallInfo.toolCall,
        options: opts,
        pathHashExtractor,
      });
      if (!output) return msg;

      compactedCount++;
      tokensSaved += output.tokensSaved;
      recordCompaction(msg.toolName ?? "", output.tokensSaved);
      diffs.push({
        messageId: msg.id,
        messageIndex: idx,
        turn: assistantTurnForIndex(
          assistantIndices,
          toolCallInfo.assistantIdx,
        ),
        role: "tool",
        kind: "tool_result",
        toolName: msg.toolName ?? "read",
        toolCallId: msg.toolCallId,
        // Only ReadResultSummary carries a `path`; for bash/search/find the
        // original code read `output.summary.path` which is `undefined` at
        // runtime. Make that explicit so it type-checks under strict tsc
        // without changing the emitted value.
        path: "path" in output.summary ? output.summary.path : undefined,
        rawTokens: output.rawTokens,
        compactedTokens: output.compactedTokens,
        tokensSaved: output.tokensSaved,
      });

      return output.message;
    }

    // Only compact assistant messages with tool calls that are not recent
    if (!isAssistantWithToolCalls(msg)) return msg;
    if (idx >= recentCutoff) return msg;

    let changed = false;
    const newToolCalls = msg.toolCalls!.map((tc) => {
      const toolResult = toolResultMap.get(tc.id);
      const strategy = matchStrategy(strategies, tc.name);
      const output = strategy?.compactToolCall?.({
        toolCall: tc,
        toolResult,
        options: opts,
      });

      if (!output) {
        return tc;
      }

      compactedCount++;
      tokensSaved += output.tokensSaved;
      recordCompaction(tc.name, output.tokensSaved);
      diffs.push({
        messageId: msg.id,
        messageIndex: idx,
        turn: assistantTurnForIndex(assistantIndices, idx),
        role: "assistant",
        kind: "tool_call",
        toolName: tc.name,
        toolCallId: tc.id,
        path: output.summary.path,
        rawTokens: output.rawTokens,
        compactedTokens: output.compactedTokens,
        tokensSaved: output.tokensSaved,
      });
      changed = true;

      return output.toolCall;
    });

    if (!changed) return msg;

    return {
      ...msg,
      toolCalls: newToolCalls,
    };
  });

  const details: StrategyCompactionDetail[] = Array.from(
    detailMap.entries(),
  ).map(([toolName, entry]) => ({
    toolName,
    compactedCount: entry.compactedCount,
    tokensSaved: entry.tokensSaved,
  }));

  return {
    messages: result,
    compactedCount,
    tokensSaved,
    details,
    diffs,
  };
}

function assistantTurnForIndex(
  assistantIndices: number[],
  messageIndex: number,
): number {
  const turn = assistantIndices.findIndex((idx) => idx === messageIndex);
  return turn === -1 ? 0 : turn + 1;
}

export function formatCompactionDiffEntry(entry: CompactionDiffEntry): string {
  const target = entry.path ? ` ${entry.path}` : "";
  const targetKind = entry.kind === "tool_result" ? "tool_result" : "assistant";
  return `turn ${entry.turn} ${targetKind}: ${entry.toolName}${target} -- raw ~${entry.rawTokens} tok -> summary ~${entry.compactedTokens} tok (saved ~${entry.tokensSaved})`;
}

/**
 * Check if a message's tool calls have been compacted.
 */
export function isCompacted(message: Message): boolean {
  if (!message.toolCalls) return false;
  return message.toolCalls.some(
    (tc) =>
      typeof tc.arguments === "object" &&
      tc.arguments !== null &&
      "compacted" in (tc.arguments as Record<string, unknown>),
  );
}

// TODO: Full compaction (LLM summary) must handle CodeProductionSummary.
// When full compaction is implemented, it should:
// 1. Detect already-compacted messages via isCompacted()
// 2. Convert CodeProductionSummary back to natural language for LLM input
//    (e.g. "wrote 200 lines to src/foo.ts" not the raw JSON summary)
// 3. Otherwise the LLM will receive structured JSON instead of natural language,
//    degrading summary quality.

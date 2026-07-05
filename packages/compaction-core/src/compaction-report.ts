import type { Message } from "./types.js";
import {
  compactCodeProductions,
  formatCompactionDiffEntry,
  DEFAULT_COMPACTION_OPTIONS,
  type CompactionDiffEntry,
  type CompactionOptions,
  type CompactionResult,
  type StrategyCompactionDetail,
} from "./compaction.js";

export type CompactionTriggerState = "disabled" | "waiting" | "active";

export interface CompactionProjectionInput {
  messages: Message[];
  rawTokens: number;
  estimateTokens: (messages: Message[]) => number;
  enabled?: boolean;
  compactAfterInputTokens?: number;
  compactionOptions?: Partial<CompactionOptions>;
}

export interface CompactionProjectionReport extends CompactionResult {
  triggerState: CompactionTriggerState;
  triggerTokens?: number;
  active: boolean;
  rawTokens: number;
  compactedTokens: number;
  effectiveTokensSaved: number;
  effectiveSavedPct: number;
  messageCount: number;
  assistantMessageCount: number;
  protectedAssistantMessageCount: number;
  options: CompactionOptions;
}

export interface CompactionReviewPayload {
  triggerState: CompactionTriggerState;
  triggerTokens?: number;
  active: boolean;
  messageCount: number;
  assistantMessageCount: number;
  protectedAssistantMessageCount: number;
  rawTokens: number;
  compactedTokens: number;
  effectiveTokensSaved: number;
  effectiveSavedPct: number;
  compactedCount: number;
  strategyTokensSaved: number;
  byTool: StrategyCompactionDetail[];
  diffs: CompactionDiffEntry[];
  options: CompactionOptions;
}

function emptyCompaction(messages: Message[]): CompactionResult {
  return {
    messages,
    compactedCount: 0,
    tokensSaved: 0,
    details: [],
    diffs: [],
  };
}

function countAssistantMessages(messages: Message[]): number {
  return messages.filter((message) => message.role === "assistant").length;
}

function calcSavedPct(rawTokens: number, savedTokens: number): number {
  if (rawTokens <= 0) return 0;
  return Math.round((savedTokens / rawTokens) * 100);
}

function countDetail(
  details: StrategyCompactionDetail[],
  toolName: string,
): number {
  return (
    details.find((detail) => detail.toolName === toolName)?.compactedCount ?? 0
  );
}

function formatNum(n: number): string {
  return n.toLocaleString();
}

export function projectCompaction(
  input: CompactionProjectionInput,
): CompactionProjectionReport {
  const options = {
    ...DEFAULT_COMPACTION_OPTIONS,
    ...input.compactionOptions,
  };
  const enabled = input.enabled ?? true;
  const triggerTokens = input.compactAfterInputTokens;
  const triggerReached =
    triggerTokens === undefined || input.rawTokens >= triggerTokens;
  const triggerState: CompactionTriggerState = !enabled
    ? "disabled"
    : triggerReached
      ? "active"
      : "waiting";
  const active = triggerState === "active";
  const compaction = active
    ? compactCodeProductions(input.messages, options)
    : emptyCompaction(input.messages);
  const compactedTokens = active
    ? input.estimateTokens(compaction.messages)
    : input.rawTokens;
  const effectiveTokensSaved = input.rawTokens - compactedTokens;
  const assistantMessageCount = countAssistantMessages(input.messages);
  const protectedAssistantMessageCount = Math.min(
    assistantMessageCount,
    Math.max(0, options.keepRecentAssistantMessages),
  );

  return {
    ...compaction,
    triggerState,
    triggerTokens,
    active,
    rawTokens: input.rawTokens,
    compactedTokens,
    effectiveTokensSaved,
    effectiveSavedPct: calcSavedPct(input.rawTokens, effectiveTokensSaved),
    messageCount: input.messages.length,
    assistantMessageCount,
    protectedAssistantMessageCount,
    options,
  };
}

export function buildCompactionReviewPayload(
  report: CompactionProjectionReport,
): CompactionReviewPayload {
  return {
    triggerState: report.triggerState,
    triggerTokens: report.triggerTokens,
    active: report.active,
    messageCount: report.messageCount,
    assistantMessageCount: report.assistantMessageCount,
    protectedAssistantMessageCount: report.protectedAssistantMessageCount,
    rawTokens: report.rawTokens,
    compactedTokens: report.compactedTokens,
    effectiveTokensSaved: report.effectiveTokensSaved,
    effectiveSavedPct: report.effectiveSavedPct,
    compactedCount: report.compactedCount,
    strategyTokensSaved: report.tokensSaved,
    byTool: report.details,
    diffs: report.diffs,
    options: report.options,
  };
}

export function formatCompactionReviewJson(
  report: CompactionProjectionReport,
): string {
  return JSON.stringify(buildCompactionReviewPayload(report), null, 2);
}

export function formatCompactionProjectionReport(
  report: CompactionProjectionReport,
  opts?: { includeDiffs?: boolean; maxDiffs?: number },
): string {
  const lines: string[] = [];
  const trigger =
    report.triggerTokens === undefined
      ? "none"
      : formatNum(report.triggerTokens);
  lines.push("Compaction report");
  lines.push(
    `  Trigger: ${report.triggerState} (compactAfterInputTokens=${trigger})`,
  );
  lines.push(
    `  Messages: ${formatNum(report.messageCount)} total, ${formatNum(report.assistantMessageCount)} assistant`,
  );
  lines.push(
    `  Protection window: ${formatNum(report.protectedAssistantMessageCount)} / ${formatNum(report.assistantMessageCount)} assistant messages kept raw (keepRecentAssistantMessages=${report.options.keepRecentAssistantMessages})`,
  );
  lines.push(
    `  Replacements: ${formatNum(report.compactedCount)} (${countDetail(report.details, "write")} write, ${countDetail(report.details, "edit")} edit, ${countDetail(report.details, "read")} read), strategy saved ~${formatNum(report.tokensSaved)} tokens`,
  );
  lines.push(
    `  Context estimate: raw ~${formatNum(report.rawTokens)} tokens -> compacted ~${formatNum(report.compactedTokens)} tokens (effective saved ~${formatNum(report.effectiveTokensSaved)}, ${report.effectiveSavedPct}%)`,
  );

  if (opts?.includeDiffs) {
    lines.push("");
    lines.push("Projected replacements:");
    if (report.diffs.length === 0) {
      lines.push("  none");
    } else {
      const maxDiffs = opts.maxDiffs ?? report.diffs.length;
      for (const diff of report.diffs.slice(0, maxDiffs)) {
        lines.push(`  ${formatCompactionDiffEntry(diff)}`);
      }
      const hidden = report.diffs.length - maxDiffs;
      if (hidden > 0) {
        lines.push(`  ... ${hidden} more replacement(s)`);
      }
    }
  }

  return lines.join("\n");
}

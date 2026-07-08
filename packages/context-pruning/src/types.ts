/**
 * Data shapes for the context-pruning package.
 *
 * Message/ToolCall are reused from compaction-core by relative type-only
 * import (no package-name resolution, no runtime dependency) — see
 * docs/arch-frontier-pruning-design-2026-07-08.md R8.
 */

import type { Message, ToolCall } from "../../compaction-core/src/types.js";

export type { Message, ToolCall };

export type TriggerType = "input_tokens" | "tool_uses";

export interface ClearToolUsesConfig {
  trigger: { type: TriggerType; value: number };
  keep: { type: "tool_uses"; value: number };
  clearAtLeast?: { type: "input_tokens"; value: number };
  excludeTools?: string[];
  clearToolInputs?: boolean | string[];
  preserveErrorResults?: boolean;
}

export interface ClearToolUsesDeps {
  estimateTokens: (messages: Message[]) => number;
  placeholder?: string;
}

export interface ClearToolUsesReport {
  type: "clear_tool_uses_replica";
  clearedToolUses: number;
  clearedInputTokens: number;
  originalInputTokens: number;
  inputTokens: number;
  gateReading: number;
}

export interface ClearToolUsesOutcome {
  messages: Message[];
  applied: boolean;
  report: ClearToolUsesReport;
}

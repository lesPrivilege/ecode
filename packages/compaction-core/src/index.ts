export type {
  Role,
  Message,
  ToolCall,
  ToolResult,
  OutputMeta,
  Diagnostic,
} from "./types.js";

export {
  compactCodeProductions,
  isCompacted,
  formatCompactionDiffEntry,
  DEFAULT_COMPACTION_OPTIONS,
  DEFAULT_TOOL_COMPACTION_STRATEGIES,
  defaultMatchStrategy,
  hashlineExtractor,
  pathLineCountExtractor,
  type CompactionOptions,
  type CompactionResult,
  type CompactionDiffEntry,
  type CompactionInjection,
  type StrategyMatcher,
  type PathHashExtractor,
  type ToolCompactionStrategy,
  type StrategyCompactionDetail,
  type CodeProductionSummary,
  type ReadResultSummary,
  type BashResultSummary,
  type SearchResultSummary,
  type FindResultSummary,
} from "./compaction.js";

export {
  projectCompaction,
  buildCompactionReviewPayload,
  formatCompactionReviewJson,
  formatCompactionProjectionReport,
  type CompactionTriggerState,
  type CompactionProjectionInput,
  type CompactionProjectionReport,
  type CompactionReviewPayload,
} from "./compaction-report.js";

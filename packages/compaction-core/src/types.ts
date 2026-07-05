/**
 * Message / tool data model consumed by the compaction core.
 *
 * These are plain, harness-agnostic data interfaces — the compaction
 * functions operate on this shape but never on any harness behavior.
 * Ported verbatim (subset) from the original taucode core so the package
 * has zero dependency on any harness code.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  id: string;
  role: Role;
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCall[];
  thinking?: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
  rawArguments?: string;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  details?: unknown;
  meta?: OutputMeta;
}

export interface OutputMeta {
  sourcePath?: string;
  artifactId?: string;
  truncated?: boolean;
  truncation?: {
    shownBytes?: number;
    totalBytes?: number;
    shownLines?: number;
    totalLines?: number;
  };
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  path: string;
  line: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

/**
 * Env-var flags surface (design §4) — seven variables, same style as
 * deterministic-compaction's ECODE_* config. Default = master switch OFF /
 * official clear_tool_uses_20250919 defaults for everything else.
 */

import type { ClearToolUsesConfig } from "./context-pruning.js";

export interface TrcFlags {
  enabled: boolean;
  config: ClearToolUsesConfig;
}

const DEFAULT_TRIGGER_TOKENS = 100_000;
const DEFAULT_KEEP = 3;

export type EnvLike = Record<string, string | undefined>;

function parseNumberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseCommaList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

function parseClearToolInputs(raw: string | undefined): boolean | string[] {
  if (raw === undefined || raw === "" || raw === "false" || raw === "0") return false;
  if (raw === "true" || raw === "1") return true;
  return parseCommaList(raw) ?? false;
}

export function parseTrcFlags(env: EnvLike): TrcFlags {
  const enabled = parseBool(env.ECODE_TRC);

  const triggerValue = parseNumberOr(env.ECODE_TRC_TRIGGER_TOKENS, DEFAULT_TRIGGER_TOKENS);
  const keepValue = parseNumberOr(env.ECODE_TRC_KEEP, DEFAULT_KEEP);
  const clearAtLeastValue = parseOptionalNumber(env.ECODE_TRC_CLEAR_AT_LEAST);
  const excludeTools = parseCommaList(env.ECODE_TRC_EXCLUDE_TOOLS);
  const clearToolInputs = parseClearToolInputs(env.ECODE_TRC_CLEAR_TOOL_INPUTS);
  const preserveErrorResults = parseBool(env.ECODE_TRC_PRESERVE_ERRORS);

  const config: ClearToolUsesConfig = {
    trigger: { type: "input_tokens", value: triggerValue },
    keep: { type: "tool_uses", value: keepValue },
    clearToolInputs,
    preserveErrorResults,
  };
  if (clearAtLeastValue !== undefined) {
    config.clearAtLeast = { type: "input_tokens", value: clearAtLeastValue };
  }
  if (excludeTools !== undefined) {
    config.excludeTools = excludeTools;
  }

  return { enabled, config };
}

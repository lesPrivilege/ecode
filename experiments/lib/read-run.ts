/**
 * Tolerant JSONL run reader — turns one arm-run file into a RunSummary for the
 * gates and the comparison report. Modelled on dogfood-p0's numberField: reads a
 * `type:"summary"` row when present, else derives totals from `type:"turn"` rows,
 * and accepts numeric fields as number OR numeric-string. Ignores `#` comments
 * and blank lines. Producer-agnostic: field name aliases cover this harness plus
 * the plausible variants a future producer might emit.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { RunSummary } from "./gates.js";

type Row = Record<string, unknown>;

export function readJsonl(path: string): Row[] {
	if (!existsSync(path)) throw new Error(`File not found: ${path}`);
	const rows: Row[] = [];
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		try {
			rows.push(JSON.parse(trimmed) as Row);
		} catch (e) {
			throw new Error(`${path}:${i + 1}: invalid JSONL: ${(e as Error).message}`);
		}
	}
	return rows;
}

function num(row: Row | undefined, fields: string[]): number {
	if (!row) return 0;
	for (const f of fields) {
		const v = row[f];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim() !== "") {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return 0;
}

/** Read a number OR explicit null (distinguishes "no signal" from 0). */
function numOrNull(row: Row | undefined, fields: string[]): number | null {
	if (!row) return null;
	for (const f of fields) {
		if (!(f in row)) continue;
		const v = row[f];
		if (v === null) return null;
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim() !== "") {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return null;
}

function str(row: Row | undefined, fields: string[], fallback: string): string {
	if (!row) return fallback;
	for (const f of fields) {
		const v = row[f];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return fallback;
}

function bool(row: Row | undefined, field: string): boolean {
	if (!row) return false;
	return row[field] === true;
}

export function summarizeRun(path: string): RunSummary {
	const rows = readJsonl(path);
	const summary = [...rows].reverse().find((r) => r.type === "summary");
	const meta = rows.find((r) => r.type === "meta");
	const turns = rows.filter((r) => r.type === "turn" || typeof r.turn === "number");
	const file = basename(path);

	const sumTurns = (fields: string[]) => turns.reduce((a, r) => a + num(r, fields), 0);

	const totalInput = summary ? num(summary, ["total_input_tokens", "total_input"]) : sumTurns(["input_tokens"]);
	const totalOutput = summary ? num(summary, ["total_output_tokens", "total_output"]) : sumTurns(["output_tokens"]);
	const totalTools = summary ? num(summary, ["total_tool_calls", "total_tools_used"]) : sumTurns(["tool_calls", "tools_used"]);
	const totalReads = summary ? num(summary, ["total_read_calls"]) : sumTurns(["read_calls"]);
	const totalReReads = summary ? num(summary, ["total_re_reads", "total_repeat_read_signals"]) : sumTurns(["re_reads", "repeat_read_signals"]);
	const compactedPathReReads = summary
		? num(summary, ["total_compacted_path_re_reads", "total_read_after_compacted_signals"])
		: sumTurns(["compacted_path_re_reads", "read_after_compacted_signals"]);
	const projectedTurns = summary ? num(summary, ["projected_turn_count"]) : turns.reduce((a, r) => a + (bool(r, "projected") ? 1 : 0), 0);
	const compactedPathCount = summary ? num(summary, ["compacted_path_count"]) : 0;
	const nativeCompactions = summary ? num(summary, ["native_compactions_observed"]) : 0;

	// rate: prefer the recorded summary value; else recompute from totals.
	let rate: number | null = null;
	if (summary && "compacted_path_re_read_rate" in summary) {
		rate = numOrNull(summary, ["compacted_path_re_read_rate"]);
	} else if (totalReads > 0) {
		rate = compactedPathReReads / totalReads;
	}

	const cacheSignal = summary ? bool(summary, "cache_signal_present") : turns.some((t) => typeof t.cache_read_tokens === "number");
	const totalCache = summary ? numOrNull(summary, ["total_cache_read_tokens"]) : cacheSignal ? sumTurns(["cache_read_tokens"]) : null;

	const mechanism = meta && meta.mechanism && typeof meta.mechanism === "object"
		? {
				nativeCompactionEnabled: bool(meta.mechanism as Row, "native_compaction_enabled"),
				seamAInstalled: bool(meta.mechanism as Row, "seam_a_installed"),
				seamBInstalled: bool(meta.mechanism as Row, "seam_b_installed"),
			}
		: null;

	return {
		arm: str(summary, ["arm"], str(meta, ["arm"], file.replace(/\.jsonl$/, ""))),
		label: str(summary, ["arm_label"], str(meta, ["arm_label"], "")),
		scenario: str(summary, ["scenario"], str(meta, ["scenario"], "")),
		file,
		turnCount: summary ? num(summary, ["turn_count"]) : turns.length,
		totalInputTokens: totalInput,
		totalOutputTokens: totalOutput,
		totalToolCalls: totalTools,
		totalReadCalls: totalReads,
		totalReReads: totalReReads,
		compactedPathCount,
		totalCompactedPathReReads: compactedPathReReads,
		compactedPathReReadRate: rate,
		projectedTurnCount: projectedTurns,
		nativeCompactionsObserved: nativeCompactions,
		totalCacheReadTokens: totalCache,
		cacheSignalPresent: cacheSignal,
		mechanism,
	};
}

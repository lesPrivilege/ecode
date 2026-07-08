/**
 * FP-1 — failure-fingerprint detectors over run JSONL. Design + capability
 * matrix: docs/fingerprint-detectors-design-2026-07-08.md. Class semantics come
 * from the recorded taxonomy (df0-charter.md:34-60, note-upstream-narrative.md:23),
 * not invented here.
 *
 * Gates-style discipline: pure functions, boolean + machine-readable reasons,
 * no editorialising. `triggered` means "this behavioural fingerprint occurred",
 * NOT "this run failed" — (a) in particular is the documented *rational* response
 * to a projection-created gap.
 *
 * Parameters are PROVISIONAL (ratification pending — 判权归人): detector output
 * must not be cited as a conclusion in reports until the defaults are ratified.
 */

import { readJsonl } from "./read-run.js";

export interface FingerprintParams {
	/** (c) minimum consecutive all-re-read turns. */
	loopStreakMin: number;
	/** (d) minimum doubt-type re-reads (re-reads not explained by compacted paths). */
	spiralDoubtMin: number;
	/** (d) maximum share of re-reads attributable to compacted paths ("≈0" quantified). */
	spiralCpShareMax: number;
}

export const FINGERPRINT_PARAMS_PROVISIONAL: FingerprintParams = {
	loopStreakMin: 4,
	spiralDoubtMin: 3,
	spiralCpShareMax: 0.1,
};

export interface FingerprintResult {
	cls: "a" | "b" | "c" | "d";
	name: string;
	triggered: boolean;
	/** True when the detector is an approximation of the recorded class semantics. */
	proxy: boolean;
	/** True when the telemetry needed by this class is absent from the file. */
	signalAbsent: boolean;
	/** Machine-readable reasons (field names / values), no narrative. */
	reasons: string[];
	evidence: Record<string, unknown>;
}

export interface FingerprintReport {
	file: string;
	arm: string;
	scenario: string;
	provider: string;
	dataKind: string;
	/** From meta.mechanism: any compaction mechanism installed. null = meta absent. */
	mechanismEngaged: boolean | null;
	a: FingerprintResult;
	b: FingerprintResult;
	c: FingerprintResult;
	d: FingerprintResult;
}

type Row = Record<string, unknown>;

interface TurnView {
	turn: number;
	inputTokens: number;
	readCalls: number;
	reReads: number;
	cpReReads: number;
	/**
	 * G4c: read calls this turn targeting a path TRC cleared earlier — the
	 * isomorphic sibling of cpReReads, mirroring cleared_path_re_reads /
	 * compacted_path_re_reads (see metrics.ts). Kept as its own field, not
	 * folded into cpReReads: the two mechanisms' semantics stay side-by-side,
	 * never merged (design §7).
	 */
	clearedPathReReads: number;
	cacheRead: number | null;
	reasoning: number | null;
	failedEditFieldsPresent: boolean;
	failedEditsOnCompactedPaths: number;
}

function num(row: Row, fields: string[], fallback = 0): number {
	for (const f of fields) {
		const v = row[f];
		if (typeof v === "number" && Number.isFinite(v)) return v;
		if (typeof v === "string" && v.trim() !== "") {
			const n = Number(v);
			if (Number.isFinite(n)) return n;
		}
	}
	return fallback;
}

function numOrNull(row: Row, field: string): number | null {
	if (!(field in row)) return null;
	const v = row[field];
	if (v === null) return null;
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function str(row: Row | undefined, fields: string[], fallback = ""): string {
	if (!row) return fallback;
	for (const f of fields) {
		const v = row[f];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return fallback;
}

function extractTurns(rows: Row[]): TurnView[] {
	const turnRows = rows.filter((r) => r.type === "turn" || typeof r.turn === "number");
	return turnRows.map((r, i) => ({
		turn: num(r, ["turn"], i + 1),
		inputTokens: num(r, ["input_tokens"]),
		readCalls: num(r, ["read_calls"]),
		reReads: num(r, ["re_reads", "repeat_read_signals"]),
		cpReReads: num(r, ["compacted_path_re_reads", "read_after_compacted_signals"]),
		clearedPathReReads: num(r, ["cleared_path_re_reads"]),
		cacheRead: numOrNull(r, "cache_read_tokens"),
		reasoning: numOrNull(r, "reasoning_tokens"),
		failedEditFieldsPresent: "failed_edit_calls" in r || "failed_edits_on_compacted_paths" in r,
		failedEditsOnCompactedPaths: num(r, ["failed_edits_on_compacted_paths"]),
	}));
}

function result(cls: FingerprintResult["cls"], name: string, over: Partial<FingerprintResult>): FingerprintResult {
	return { cls, name, triggered: false, proxy: false, signalAbsent: false, reasons: [], evidence: {}, ...over };
}

const NO_TURNS_REASON = "no turn rows (degenerate run)";

/**
 * (a) information-gap: the model re-read paths whose views had been removed
 * from context — either compacted away (DC) or cleared away (TRC, G4c). Same
 * entry point for both mechanisms (they produce the same phenomenological
 * fingerprint: a removal, then a re-read of the removed path); the two
 * signals are kept side-by-side in reasons/evidence, never merged into one
 * blended count (design §7's "同一入口并列，不合并语义"). On any file that
 * predates cleared_path_re_reads (or where TRC never applied), clearedTotal
 * is 0 and this reduces byte-for-byte to the original compacted-path-only
 * output — a pre-G4c golden fixture assertion is unaffected by this change.
 */
function detectInformationGap(turns: TurnView[]): FingerprintResult {
	if (turns.length === 0) return result("a", "information-gap", { reasons: [NO_TURNS_REASON] });
	const gapTurns = turns.filter((t) => t.cpReReads > 0).map((t) => t.turn);
	const total = turns.reduce((a, t) => a + t.cpReReads, 0);
	const clearedGapTurns = turns.filter((t) => t.clearedPathReReads > 0).map((t) => t.turn);
	const clearedTotal = turns.reduce((a, t) => a + t.clearedPathReReads, 0);
	const triggered = total > 0 || clearedTotal > 0;
	const reasons: string[] = [];
	if (total > 0) reasons.push(`compacted_path_re_reads=${total} across ${gapTurns.length} turns`);
	if (clearedTotal > 0) reasons.push(`cleared_path_re_reads=${clearedTotal} across ${clearedGapTurns.length} turns`);
	return result("a", "information-gap", {
		triggered,
		reasons,
		evidence: { totalCompactedPathReReads: total, gapTurns, totalClearedPathReReads: clearedTotal, clearedGapTurns },
	});
}

/**
 * (b) summary-defect: acting on a compacted view fails. Needs per-turn failed-edit
 * telemetry (additive schema increment `failed_edit_calls` /
 * `failed_edits_on_compacted_paths`); on files without those fields the detector
 * reports signal-absent instead of guessing.
 */
function detectSummaryDefect(turns: TurnView[]): FingerprintResult {
	if (turns.length === 0) return result("b", "summary-defect", { signalAbsent: true, reasons: [NO_TURNS_REASON] });
	const signalPresent = turns.some((t) => t.failedEditFieldsPresent);
	if (!signalPresent) {
		return result("b", "summary-defect", {
			signalAbsent: true,
			reasons: ["failed-edit telemetry absent (schema increment not in this producer)"],
			evidence: { failedEditsOnCompactedPaths: null },
		});
	}
	const total = turns.reduce((a, t) => a + t.failedEditsOnCompactedPaths, 0);
	const triggered = total > 0;
	return result("b", "summary-defect", {
		triggered,
		reasons: triggered ? [`failed_edits_on_compacted_paths=${total}`] : [],
		evidence: { failedEditsOnCompactedPaths: total },
	});
}

/**
 * (c) loop-pathology PROXY: K consecutive turns whose reads are ALL re-reads.
 * The recorded semantics ("same path repeatedly, no progress") need per-read
 * path events — not in run JSONL — so this stays marked proxy.
 */
function detectLoopPathology(turns: TurnView[], params: FingerprintParams): FingerprintResult {
	if (turns.length === 0) return result("c", "loop-pathology", { proxy: true, reasons: [NO_TURNS_REASON] });
	let streak = 0;
	let start = 0;
	let maxStreak = 0;
	let maxRange: [number, number] | null = null;
	for (const t of turns) {
		const allReRead = t.readCalls > 0 && t.reReads >= t.readCalls;
		if (allReRead) {
			if (streak === 0) start = t.turn;
			streak++;
			if (streak > maxStreak) {
				maxStreak = streak;
				maxRange = [start, t.turn];
			}
		} else {
			streak = 0;
		}
	}
	const triggered = maxStreak >= params.loopStreakMin;
	return result("c", "loop-pathology", {
		triggered,
		proxy: true,
		reasons: triggered ? [`all-re-read streak=${maxStreak} >= ${params.loopStreakMin} (turns ${maxRange![0]}..${maxRange![1]}; PROXY, per-path events unavailable)`] : [],
		evidence: { maxStreak, streakTurns: maxRange },
	});
}

/**
 * (d) confirmation-spiral: re-reads NOT explained by compacted paths (the recorded
 * discriminator `re_reads > 0 且 compacted_path_re_reads ≈ 0`). Cache-hit ratio
 * over the doubt turns and reasoning presence are annotations, not gate conditions.
 * On a run whose arm never engaged a compaction mechanism, cp≈0 is structural —
 * annotated as vacuousBaseline rather than suppressed.
 */
function detectConfirmationSpiral(turns: TurnView[], params: FingerprintParams, mechanismEngaged: boolean | null): FingerprintResult {
	if (turns.length === 0) return result("d", "confirmation-spiral", { reasons: [NO_TURNS_REASON] });
	const totalReReads = turns.reduce((a, t) => a + t.reReads, 0);
	const totalCp = turns.reduce((a, t) => a + t.cpReReads, 0);
	const doubtReReads = turns.reduce((a, t) => a + Math.max(0, t.reReads - t.cpReReads), 0);
	const cpShare = totalReReads > 0 ? totalCp / totalReReads : 0;
	const doubtTurns = turns.filter((t) => Math.max(0, t.reReads - t.cpReReads) > 0).map((t) => t.turn);

	const cacheTurns = turns.filter((t) => doubtTurns.includes(t.turn) && t.cacheRead !== null);
	const cacheHitRatioDoubtWindow =
		cacheTurns.length > 0 && cacheTurns.reduce((a, t) => a + t.inputTokens, 0) > 0
			? cacheTurns.reduce((a, t) => a + (t.cacheRead as number), 0) / cacheTurns.reduce((a, t) => a + t.inputTokens, 0)
			: null;
	const reasoningSignal = turns.some((t) => t.reasoning !== null) ? "present" : "absent";
	const vacuousBaseline = mechanismEngaged === false;

	const triggered = totalReReads > 0 && doubtReReads >= params.spiralDoubtMin && cpShare <= params.spiralCpShareMax;
	const reasons: string[] = [];
	if (triggered) {
		reasons.push(`doubt_re_reads=${doubtReReads} >= ${params.spiralDoubtMin} AND cp_share=${cpShare.toFixed(4)} <= ${params.spiralCpShareMax}`);
		if (vacuousBaseline) {
			reasons.push("vacuous baseline context: no compaction mechanism engaged, cp_share≈0 is structural");
		}
	}
	return result("d", "confirmation-spiral", {
		triggered,
		reasons,
		evidence: {
			doubtReReads,
			totalReReads,
			cpReReads: totalCp,
			cpShare,
			doubtTurns,
			cacheHitRatioDoubtWindow,
			reasoningSignal,
			vacuousBaseline,
		},
	});
}

/** Fingerprint one run JSONL file (any producer readable by the tolerant reader). */
export function fingerprintFile(path: string, params: FingerprintParams = FINGERPRINT_PARAMS_PROVISIONAL): FingerprintReport {
	const rows = readJsonl(path);
	const meta = rows.find((r) => r.type === "meta");
	const turns = extractTurns(rows);

	let mechanismEngaged: boolean | null = null;
	if (meta && meta.mechanism && typeof meta.mechanism === "object") {
		const m = meta.mechanism as Row;
		// G4c: trc_installed (arm T) is a THIRD, independent mechanism family —
		// it engages with native_compaction_enabled and seam_a_installed both
		// false, so without this check arm T would be misread as a vacuous
		// baseline (D8-class error the (d) detector's vacuousBaseline annotation
		// exists specifically to flag).
		mechanismEngaged = m.native_compaction_enabled === true || m.seam_a_installed === true || m.trc_installed === true;
	}

	return {
		file: path,
		arm: str(meta, ["arm"]),
		scenario: str(meta, ["scenario"]),
		provider: str(meta, ["provider"]),
		dataKind: str(meta, ["data_kind"]),
		mechanismEngaged,
		a: detectInformationGap(turns),
		b: detectSummaryDefect(turns),
		c: detectLoopPathology(turns, params),
		d: detectConfirmationSpiral(turns, params, mechanismEngaged),
	};
}

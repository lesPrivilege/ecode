/**
 * Codified judgment gates — `invalid` and `suspicious` — as pure functions over
 * parsed run summaries. These are NOT prose guidance; compare.ts calls them and
 * the unit tests (test/gates.test.ts) exercise them against contrived JSONL
 * fixtures. No editorialising: a gate returns a boolean + the fields that fired
 * it, nothing about whether that is "good" or "bad".
 *
 * A gate reads a RunSummary, which is produced by a tolerant field reader
 * (mirroring dogfood-p0's numberField) so it works on any producer's JSONL, not
 * just this harness's exact schema.
 */

/** Tolerant, producer-agnostic view of one run's summary + turns. */
export interface RunSummary {
	arm: string;
	label: string;
	scenario: string;
	file: string;
	turnCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalToolCalls: number;
	totalReadCalls: number;
	totalReReads: number;
	compactedPathCount: number;
	totalCompactedPathReReads: number;
	compactedPathReReadRate: number | null;
	projectedTurnCount: number;
	nativeCompactionsObserved: number;
	totalCacheReadTokens: number | null;
	cacheSignalPresent: boolean;
	/** Which arm mechanism this run relied on, from the meta row when present. */
	mechanism: {
		nativeCompactionEnabled: boolean;
		seamAInstalled: boolean;
		seamBInstalled: boolean;
	} | null;
}

export interface GateResult {
	triggered: boolean;
	/** Machine-readable reasons (field names / values), no narrative. */
	reasons: string[];
}

/**
 * INVALID — the arm's compaction mechanism never actually triggered, so any
 * delta against it is meaningless. Determined per-arm from what the run relied on:
 *
 *   - seam-A arm (C/D): invalid if NO turn was projected (`projected_turn_count`
 *     == 0) — the transcript never crossed `compactAfterInputTokens`, so the hook
 *     was inert.
 *   - seam-B arm (D): additionally requires seam-A to have engaged (seam B is a
 *     checkpoint layered on the same crossing); the projected==0 check covers it.
 *   - native-on arm (B): invalid if pi's own compaction never fired
 *     (`native_compactions_observed` == 0).
 *   - baseline arm (A): A is the reference; "no compaction" IS its engaged state,
 *     so A is never invalid on this basis. (It can still be a degenerate run if it
 *     has zero turns; that is flagged separately.)
 *
 * When the meta mechanism block is absent, fall back to: projected>0 OR
 * native>0 OR it's a plain baseline (no mechanism claimed).
 */
export function checkInvalid(run: RunSummary): GateResult {
	const reasons: string[] = [];

	if (run.turnCount <= 0) {
		reasons.push("turn_count=0 (empty run)");
		return { triggered: true, reasons };
	}

	const m = run.mechanism;
	// Seam-A/-B arms must have projected at least once.
	const reliesOnSeamA = m ? m.seamAInstalled : run.projectedTurnCount > 0 || run.compactedPathCount > 0;
	if (reliesOnSeamA && run.projectedTurnCount <= 0) {
		reasons.push("seam-A arm but projected_turn_count=0 (threshold never crossed)");
	}

	// Native-on arm must have compacted at least once.
	const reliesOnNative = m ? m.nativeCompactionEnabled && !m.seamAInstalled : false;
	if (reliesOnNative && run.nativeCompactionsObserved <= 0) {
		reasons.push("native-on arm but native_compactions_observed=0");
	}

	return { triggered: reasons.length > 0, reasons };
}

/**
 * SUSPICIOUS (false-savings) — compared to the baseline arm A, this arm's total
 * tokens went DOWN while churn went UP. This is the taucode negative case: token
 * savings that are actually harmful behaviour (the agent re-reading paths it was
 * told were summarised) hiding behind a smaller context.
 *
 * Fires when BOTH hold:
 *   (1) total tokens (input+output) strictly less than baseline's, AND
 *   (2) churn increased vs. baseline — EITHER re-read count went up OR the
 *       compacted-path re-read rate went up. (rate compared only when both sides
 *       have a defined rate; a null rate contributes nothing.)
 *
 * Never fires for the baseline against itself. Reports the numbers that fired it;
 * does not say whether the trade is worth it.
 */
export function checkSuspicious(run: RunSummary, baseline: RunSummary): GateResult {
	const reasons: string[] = [];
	if (run.arm === baseline.arm && run.file === baseline.file) {
		return { triggered: false, reasons };
	}

	const runTotal = run.totalInputTokens + run.totalOutputTokens;
	const baseTotal = baseline.totalInputTokens + baseline.totalOutputTokens;
	const tokensDown = runTotal < baseTotal;
	if (!tokensDown) {
		return { triggered: false, reasons };
	}

	const reReadUp = run.totalReReads > baseline.totalReReads;
	const rateComparable = run.compactedPathReReadRate !== null && baseline.compactedPathReReadRate !== null;
	const rateUp = rateComparable && (run.compactedPathReReadRate as number) > (baseline.compactedPathReReadRate as number);

	if (reReadUp) {
		reasons.push(`total_tokens down (${runTotal} < ${baseTotal}) AND re_reads up (${run.totalReReads} > ${baseline.totalReReads})`);
	}
	if (rateUp) {
		reasons.push(
			`total_tokens down (${runTotal} < ${baseTotal}) AND compacted_path_re_read_rate up ` +
				`(${(run.compactedPathReReadRate as number).toFixed(4)} > ${(baseline.compactedPathReReadRate as number).toFixed(4)})`,
		);
	}

	return { triggered: reasons.length > 0, reasons };
}

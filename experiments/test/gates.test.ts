/**
 * Unit tests for the codified invalid/suspicious gates, driven by small contrived
 * JSONL fixtures written to a temp dir and read back through the SAME tolerant
 * reader (summarizeRun) that compare.ts uses — so the test exercises the real
 * file->summary->gate path, not a hand-built RunSummary.
 *
 * Required cases (per the task):
 *   - one fixture that MUST trigger `invalid`
 *   - one fixture that MUST trigger `suspicious`
 *   - one clean fixture that must trigger NEITHER
 * plus edge cases pinning the exact semantics.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvalid, checkSuspicious } from "../lib/gates.js";
import { summarizeRun } from "../lib/read-run.js";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ecode-gates-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write JSONL rows to a file and return its path. */
function fixture(name: string, rows: object[]): string {
	const p = join(dir, name);
	writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
	return p;
}

function meta(arm: string, mech: Partial<Record<string, boolean>>) {
	return {
		type: "meta",
		arm,
		arm_label: `arm ${arm}`,
		scenario: "fx",
		mechanism: {
			native_compaction_enabled: mech.native ?? false,
			seam_a_installed: mech.seamA ?? false,
			seam_b_installed: mech.seamB ?? false,
		},
	};
}

function summary(arm: string, over: Record<string, unknown>) {
	return {
		type: "summary",
		arm,
		arm_label: `arm ${arm}`,
		scenario: "fx",
		session_id: "sid",
		workspace: "/tmp/x",
		turn_count: 4,
		total_input_tokens: 1000,
		total_output_tokens: 100,
		total_tool_calls: 4,
		total_read_calls: 4,
		total_re_reads: 0,
		compacted_path_count: 0,
		total_compacted_path_re_reads: 0,
		compacted_path_re_read_rate: 0,
		projected_turn_count: 0,
		native_compactions_observed: 0,
		total_cache_read_tokens: null,
		cache_signal_present: false,
		completion: "",
		data_kind: "synthetic-smoke-fixture",
		...over,
	};
}

describe("invalid gate", () => {
	it("TRIGGERS for a seam-A arm that never projected (threshold never crossed)", () => {
		const p = fixture("invalid-seamA.jsonl", [
			meta("C", { seamA: true }),
			summary("C", { projected_turn_count: 0, total_read_calls: 3 }),
		]);
		const run = summarizeRun(p);
		const res = checkInvalid(run);
		expect(res.triggered).toBe(true);
		expect(res.reasons.join(" ")).toContain("projected_turn_count=0");
	});

	it("TRIGGERS for a native-on arm that never compacted", () => {
		const p = fixture("invalid-native.jsonl", [
			meta("B", { native: true }),
			summary("B", { native_compactions_observed: 0 }),
		]);
		const run = summarizeRun(p);
		const res = checkInvalid(run);
		expect(res.triggered).toBe(true);
		expect(res.reasons.join(" ")).toContain("native_compactions_observed=0");
	});

	it("TRIGGERS for an empty run (zero turns)", () => {
		const p = fixture("invalid-empty.jsonl", [meta("C", { seamA: true }), summary("C", { turn_count: 0 })]);
		const run = summarizeRun(p);
		expect(checkInvalid(run).triggered).toBe(true);
	});

	it("does NOT trigger for the baseline arm A with no compaction (its engaged state)", () => {
		const p = fixture("valid-baselineA.jsonl", [
			meta("A", {}),
			summary("A", { projected_turn_count: 0, native_compactions_observed: 0 }),
		]);
		const run = summarizeRun(p);
		expect(checkInvalid(run).triggered).toBe(false);
	});

	it("does NOT trigger for a seam-A arm that DID project", () => {
		const p = fixture("valid-seamA.jsonl", [
			meta("C", { seamA: true }),
			summary("C", { projected_turn_count: 3 }),
		]);
		const run = summarizeRun(p);
		expect(checkInvalid(run).triggered).toBe(false);
	});
});

describe("suspicious gate (false-savings)", () => {
	// Baseline arm A: high tokens, low churn.
	function baselineFile() {
		return fixture("susp-baseA.jsonl", [
			meta("A", {}),
			summary("A", {
				total_input_tokens: 10000,
				total_output_tokens: 500,
				total_re_reads: 1,
				total_read_calls: 6,
				total_compacted_path_re_reads: 0,
				compacted_path_re_read_rate: 0,
			}),
		]);
	}

	it("TRIGGERS when tokens go DOWN but re-reads go UP vs baseline", () => {
		const base = summarizeRun(baselineFile());
		const p = fixture("susp-armC.jsonl", [
			meta("C", { seamA: true }),
			summary("C", {
				total_input_tokens: 5000, // down
				total_output_tokens: 500,
				total_re_reads: 5, // up (1 -> 5)
				total_read_calls: 8,
				total_compacted_path_re_reads: 4,
				compacted_path_re_read_rate: 0.5,
				projected_turn_count: 3,
			}),
		]);
		const run = summarizeRun(p);
		const res = checkSuspicious(run, base);
		expect(res.triggered).toBe(true);
		expect(res.reasons.join(" ")).toContain("re_reads up");
	});

	it("TRIGGERS on rate increase alone when tokens are down (re-reads flat)", () => {
		const base = summarizeRun(baselineFile());
		const p = fixture("susp-rate.jsonl", [
			meta("C", { seamA: true }),
			summary("C", {
				total_input_tokens: 5000, // down
				total_output_tokens: 500,
				total_re_reads: 1, // flat vs baseline
				total_read_calls: 6,
				total_compacted_path_re_reads: 3,
				compacted_path_re_read_rate: 0.5, // up vs baseline 0
				projected_turn_count: 3,
			}),
		]);
		const run = summarizeRun(p);
		const res = checkSuspicious(run, base);
		expect(res.triggered).toBe(true);
		expect(res.reasons.join(" ")).toContain("compacted_path_re_read_rate up");
	});

	it("does NOT trigger when tokens go down AND churn also goes down (clean win-shape)", () => {
		const base = summarizeRun(baselineFile());
		const p = fixture("clean-armC.jsonl", [
			meta("C", { seamA: true }),
			summary("C", {
				total_input_tokens: 5000, // down
				total_output_tokens: 500,
				total_re_reads: 0, // down (1 -> 0)
				total_read_calls: 6,
				total_compacted_path_re_reads: 0,
				compacted_path_re_read_rate: 0, // not up
				projected_turn_count: 3,
			}),
		]);
		const run = summarizeRun(p);
		expect(checkSuspicious(run, base).triggered).toBe(false);
	});

	it("does NOT trigger when tokens go UP (even if churn also up) — not a false-saving", () => {
		const base = summarizeRun(baselineFile());
		const p = fixture("nosusp-tokensup.jsonl", [
			meta("C", { seamA: true }),
			summary("C", {
				total_input_tokens: 20000, // UP
				total_output_tokens: 500,
				total_re_reads: 9, // up, but tokens didn't drop
				total_read_calls: 12,
				total_compacted_path_re_reads: 8,
				compacted_path_re_read_rate: 0.66,
				projected_turn_count: 3,
			}),
		]);
		const run = summarizeRun(p);
		expect(checkSuspicious(run, base).triggered).toBe(false);
	});

	it("never flags the baseline against itself", () => {
		const basePath = baselineFile();
		const base = summarizeRun(basePath);
		expect(checkSuspicious(base, base).triggered).toBe(false);
	});
});

describe("clean case (neither gate)", () => {
	it("a well-formed seam-A run that projected and did not churn triggers neither gate", () => {
		const basePath = fixture("clean-base.jsonl", [
			meta("A", {}),
			summary("A", { total_input_tokens: 10000, total_output_tokens: 500, total_re_reads: 2, total_read_calls: 6, compacted_path_re_read_rate: 0 }),
		]);
		const base = summarizeRun(basePath);
		const p = fixture("clean-run.jsonl", [
			meta("C", { seamA: true }),
			summary("C", {
				total_input_tokens: 7000,
				total_output_tokens: 500,
				total_re_reads: 1, // not up
				total_read_calls: 6,
				total_compacted_path_re_reads: 1,
				compacted_path_re_read_rate: 0, // not up vs baseline 0
				projected_turn_count: 4,
			}),
		]);
		const run = summarizeRun(p);
		expect(checkInvalid(run).triggered).toBe(false);
		expect(checkSuspicious(run, base).triggered).toBe(false);
	});
});

/**
 * G4c acceptance: TRC (arm T) run output must be directly consumable by the
 * existing report/FP-1 toolchain. Drives ONE real arm-T run (mock provider,
 * `synthetic-smoke-fixture` — never a reportable finding, per the packet's
 * forbidden zone), then verifies the full chain: turn rows carry `trc` +
 * `cleared_path_re_reads`, the FP-1 (a) detector fires on the cleared-path
 * re-read, (b) reports signal-absent, and the mechanism is correctly read as
 * engaged (not a vacuous baseline). A second test checks backward
 * compatibility: a hand-written pre-G4c-shaped row (no trc/cleared_path_re_reads
 * fields at all) still parses and fingerprints byte-identically to the
 * original compacted-path-only behavior.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fingerprintFile } from "../lib/fingerprints.js";
import { readJsonl } from "../lib/read-run.js";

const EXPERIMENTS_DIR = fileURLToPath(new URL("..", import.meta.url));

function runTrcArm(outPath: string, extraArgs: string[] = []): void {
	execFileSync(
		process.execPath,
		[
			"--experimental-transform-types",
			"--import",
			"./lib/register.mjs",
			"run.ts",
			"--arm",
			"T",
			"--scenario",
			"refactor",
			"--provider",
			"mock",
			"--out",
			outPath,
			...extraArgs,
		],
		{ cwd: EXPERIMENTS_DIR, stdio: "pipe" },
	);
}

describe("G4c synthetic fixture run — arm T (TRC)", () => {
	it("produces a JSONL whose turn rows carry trc + cleared_path_re_reads, and the FP-1 toolchain reads it correctly", () => {
		const dir = mkdtempSync(join(tmpdir(), "g4c-trc-fixture-"));
		const outPath = join(dir, "T-refactor.jsonl");
		try {
			runTrcArm(outPath, ["--trc-trigger-tokens", "1", "--trc-keep", "1"]);

			const rows = readJsonl(outPath);
			const meta = rows.find((r) => r.type === "meta") as Record<string, unknown> | undefined;
			expect(meta).toBeDefined();
			// Never a reportable finding — synthetic fixture tag, per forbidden zone.
			expect(meta?.data_kind).toBe("synthetic-smoke-fixture");
			const mechanism = meta?.mechanism as Record<string, unknown> | undefined;
			expect(mechanism?.trc_installed).toBe(true);
			expect(mechanism?.native_compaction_enabled).toBe(false);
			expect(mechanism?.seam_a_installed).toBe(false);

			const turns = rows.filter((r) => r.type === "turn");
			expect(turns.length).toBeGreaterThan(0);
			// trc is populated (object or explicit null) on EVERY turn — never absent.
			for (const t of turns) expect(Object.prototype.hasOwnProperty.call(t, "trc")).toBe(true);
			expect(turns.some((t) => (t as { trc?: { applied?: boolean } }).trc?.applied === true)).toBe(true);
			// the refactor scenario's natural turn-8 re-read lands on a cleared path
			// once TRC runs this aggressively (see G4c completion report for the probe).
			const totalClearedReReads = turns.reduce(
				(sum, t) => sum + ((t as { cleared_path_re_reads?: number }).cleared_path_re_reads ?? 0),
				0,
			);
			expect(totalClearedReReads).toBeGreaterThan(0);

			const summary = rows.find((r) => r.type === "summary") as Record<string, unknown> | undefined;
			expect(summary?.total_cleared_path_re_reads).toBe(totalClearedReReads);
			expect(typeof summary?.cleared_path_count).toBe("number");
			expect((summary?.cleared_path_count as number) ?? 0).toBeGreaterThan(0);

			// Full FP-1 chain, same file, same tolerant reader.
			const report = fingerprintFile(outPath);
			expect(report.dataKind).toBe("synthetic-smoke-fixture");
			expect(report.mechanismEngaged).toBe(true); // not a vacuous baseline — TRC IS the mechanism
			expect(report.a.triggered).toBe(true);
			expect(report.a.signalAbsent).toBe(false);
			expect(report.a.reasons.some((r) => r.startsWith("cleared_path_re_reads="))).toBe(true);
			expect((report.a.evidence as { totalClearedPathReReads?: number }).totalClearedPathReReads).toBeGreaterThan(0);
			// (b) structurally inapplicable to TRC (no summarisation step, design §7).
			expect(report.b.signalAbsent).toBe(true);
			expect(report.b.triggered).toBe(false);
			// (d) vacuousBaseline must be false: TRC engaged, cp_share≈0 here is not structural.
			expect((report.d.evidence as { vacuousBaseline?: boolean }).vacuousBaseline).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30000);

	it("backward compatibility: a pre-G4c row (no trc/cleared_path_re_reads fields) parses and fingerprints byte-identically to the original compacted-path-only output", () => {
		const dir = mkdtempSync(join(tmpdir(), "g4c-backcompat-"));
		const outPath = join(dir, "legacy.jsonl");
		try {
			const legacyMeta = {
				type: "meta",
				schema_version: 1,
				arm: "C",
				arm_label: "seam-A hook / seam-B off",
				scenario: "refactor",
				provider: "mock",
				mechanism: {
					native_compaction_enabled: false,
					seam_a_installed: true,
					seam_b_installed: false,
					compact_after_input_tokens: 100,
					keep_recent_assistant_messages: 3,
				},
				started_at: new Date(0).toISOString(),
				data_kind: "synthetic-smoke-fixture",
			};
			// Deliberately has NO trc / cleared_path_re_reads fields — the exact shape
			// any pre-G4c producer or archived corpus file has.
			const legacyTurn = {
				type: "turn",
				turn: 1,
				input_tokens: 500,
				output_tokens: 10,
				output_from_usage: true,
				reasoning_tokens: null,
				tool_calls: 1,
				read_calls: 1,
				re_reads: 1,
				compacted_path_re_reads: 1,
				projected: true,
				cache_read_tokens: null,
				tail_blocks: [],
				anchor_lines: 0,
				anchor_hash: null,
				completion: "",
			};
			const body = [legacyMeta, legacyTurn].map((r) => JSON.stringify(r)).join("\n");
			writeFileSync(outPath, `# legacy pre-G4c fixture (hand-written, not a real run)\n${body}\n`, "utf-8");

			const report = fingerprintFile(outPath);
			expect(report.mechanismEngaged).toBe(true);
			expect(report.a.triggered).toBe(true);
			// Byte-identical to the pre-G4c single-reason, two-key-evidence shape for
			// this exact scenario (clearedTotal=0 -> the new branches never fire).
			expect(report.a.reasons).toEqual(["compacted_path_re_reads=1 across 1 turns"]);
			const evidence = report.a.evidence as {
				totalCompactedPathReReads?: number;
				gapTurns?: number[];
				totalClearedPathReReads?: number;
				clearedGapTurns?: number[];
			};
			expect(evidence.totalCompactedPathReReads).toBe(1);
			expect(evidence.gapTurns).toEqual([1]);
			expect(evidence.totalClearedPathReReads).toBe(0);
			expect(evidence.clearedGapTurns).toEqual([]);
			expect(report.b.signalAbsent).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

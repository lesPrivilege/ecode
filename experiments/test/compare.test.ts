import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ecode-compare-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runFile(provider: string, dataKind: string): string {
	const p = join(dir, `${provider}.jsonl`);
	const rows = [
		{ type: "meta", arm: "A", arm_label: "a", scenario: "fx", provider, data_kind: dataKind },
		{
			type: "summary",
			arm: "A",
			arm_label: "a",
			scenario: "fx",
			provider,
			session_id: "sid",
			workspace: "/tmp/x",
			turn_count: 1,
			total_input_tokens: 10,
			total_output_tokens: 1,
			total_tool_calls: 0,
			total_read_calls: 0,
			total_re_reads: 0,
			compacted_path_count: 0,
			total_compacted_path_re_reads: 0,
			compacted_path_re_read_rate: 0,
			projected_turn_count: 0,
			native_compactions_observed: 0,
			total_cache_read_tokens: null,
			cache_signal_present: false,
			completion: "",
			data_kind: dataKind,
		},
	];
	writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	return p;
}

function compareOutput(file: string): string {
	return execFileSync(
		process.execPath,
		[
			"--no-warnings",
			"--experimental-transform-types",
			"--import",
			resolve("lib/register.mjs"),
			resolve("compare.ts"),
			"--in",
			file,
			"--baseline",
			"A",
		],
		{ cwd: resolve("."), encoding: "utf8" },
	);
}

describe("compare data label", () => {
	it("keeps the synthetic warning only for mock runs", () => {
		expect(compareOutput(runFile("mock", "synthetic-smoke-fixture"))).toContain("SYNTHETIC SMOKE FIXTURES");
	});

	it("labels DeepSeek packet runs as real workload data", () => {
		const out = compareOutput(runFile("deepseek", "g2-packet-run"));
		expect(out).toContain("REAL WORKLOAD DATA");
		expect(out).toContain("provider=deepseek");
		expect(out).not.toContain("SYNTHETIC SMOKE FIXTURES");
	});
});

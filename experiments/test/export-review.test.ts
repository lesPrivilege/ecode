import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ecode-review-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("export-review", () => {
	it("packages a session path, ambient rows, and trigger markers into markdown", () => {
		const sessionId = "019f3310-ee70-7679-b26d-aea473ac7706";
		const session = join(dir, `2026-07-05_${sessionId}.jsonl`);
		const ambientDir = join(dir, "ambient");
		const out = join(dir, "review.md");
		mkdirSync(ambientDir, { recursive: true });
		writeFileSync(session, "{}\n", "utf8");
		writeFileSync(
			join(ambientDir, `${sessionId}.jsonl`),
			[
				{ type: "session", written_at: "t1", session_id: sessionId, turn_count: 1, projected_turn_count: 0, total_cache_read_tokens: 10, trust_protocol_enabled: false },
				{ type: "session", written_at: "t2", session_id: sessionId, turn_count: 2, projected_turn_count: 1, total_cache_read_tokens: 20, trust_protocol_enabled: false },
			]
				.map((r) => JSON.stringify(r))
				.join("\n") + "\n",
			"utf8",
		);

		execFileSync(
			process.execPath,
			[
				"--no-warnings",
				"--experimental-transform-types",
				resolve("export-review.ts"),
				"--session",
				session,
				"--ambient-dir",
				ambientDir,
				"--out",
				out,
			],
			{ cwd: resolve("."), encoding: "utf8" },
		);

		expect(existsSync(out)).toBe(true);
		const text = readFileSync(out, "utf8");
		expect(text).toContain(`Session review — ${sessionId}`);
		expect(text).toContain("ambient_rows: 2");
		expect(text).toContain("projected_turn_count 0 -> 1");
		expect(text).toContain("F-A compactable/content-saved");
	});
});

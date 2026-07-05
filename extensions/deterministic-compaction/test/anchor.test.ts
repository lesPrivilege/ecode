/**
 * V3-WS task 1 — work-semantic anchor block (pure module).
 *
 * The anchor is the deterministic answer to "what have I done / where am I" that
 * survives a projection. It is derived ENTIRELY from tool events (zero LLM) and
 * carries only mechanically verifiable facts (trust-protocol discipline): files
 * read + hash, edits + diffstat + hash, tests run + result, pending acceptance
 * targets. No evaluative or inferential language — an edit that failed is recorded
 * as failed, never dressed up.
 *
 * This file pins the pure surface: WorkAnchor (state accumulation), renderAnchorBlock
 * (sectioned format), parseTestResult (bash → test record), anchorTailMessage
 * (volatile-tail carrier, mirrors staleHintMessage).
 */

import { describe, it, expect } from "vitest";
import {
	WorkAnchor,
	renderAnchorBlock,
	anchorTailMessage,
	parseTestResult,
} from "../src/anchor.ts";

describe("renderAnchorBlock — empty state", () => {
	it("returns [] when nothing has been touched and there are no pending targets", () => {
		const snap = new WorkAnchor().snapshot();
		expect(renderAnchorBlock(snap, 7)).toEqual([]);
	});

	it("returns [] when only the header would be present (no sections, no pending)", () => {
		const snap = new WorkAnchor().snapshot();
		expect(renderAnchorBlock(snap, 7, [])).toEqual([]);
	});
});

describe("renderAnchorBlock — read section", () => {
	it("lists read-only paths as path@hash, alphabetically", () => {
		const a = new WorkAnchor();
		a.recordRead("src/b.ts", "bbbb2222", 2);
		a.recordRead("src/a.ts", "aaaa1111", 1);
		expect(renderAnchorBlock(a.snapshot(), 3)).toEqual([
			"[work-anchor] turn 3",
			"read: src/a.ts@aaaa1111, src/b.ts@bbbb2222",
		]);
	});

	it("keeps only the latest hash for a re-read path", () => {
		const a = new WorkAnchor();
		a.recordRead("src/a.ts", "old00000", 1);
		a.recordRead("src/a.ts", "new11111", 4);
		expect(renderAnchorBlock(a.snapshot(), 5)).toEqual([
			"[work-anchor] turn 5",
			"read: src/a.ts@new11111",
		]);
	});
});

describe("renderAnchorBlock — edits section", () => {
	it("renders an edit with diffstat and post-write hash", () => {
		const a = new WorkAnchor();
		a.recordEdit("src/c.ts", "99aabbcc", "+40 -0", 6);
		expect(renderAnchorBlock(a.snapshot(), 6)).toEqual([
			"[work-anchor] turn 6",
			"edits: src/c.ts +40 -0 hash 99aabbcc",
		]);
	});

	it("shows Y→Z when a prior hash for the path is known (read then edit)", () => {
		const a = new WorkAnchor();
		a.recordRead("src/d.ts", "11223344", 1);
		a.recordEdit("src/d.ts", "55667788", "+5 -2", 2);
		expect(renderAnchorBlock(a.snapshot(), 2)).toEqual([
			"[work-anchor] turn 2",
			"edits: src/d.ts +5 -2 hash 11223344→55667788",
		]);
	});

	it("an edited path is NOT duplicated in the read section", () => {
		const a = new WorkAnchor();
		a.recordRead("src/d.ts", "11223344", 1);
		a.recordEdit("src/d.ts", "55667788", "+5 -2", 2);
		const lines = renderAnchorBlock(a.snapshot(), 2);
		expect(lines.some((l) => l.startsWith("read:"))).toBe(false);
	});

	it("records a failed edit honestly, with no hash", () => {
		const a = new WorkAnchor();
		a.recordEditFailure("src/e.ts", 3);
		expect(renderAnchorBlock(a.snapshot(), 3)).toEqual([
			"[work-anchor] turn 3",
			"edits: src/e.ts failed",
		]);
	});
});

describe("renderAnchorBlock — tests section", () => {
	it("renders test runs as command → result, in run order", () => {
		const a = new WorkAnchor();
		a.recordTest("npm test", "7/7 pass", 8);
		a.recordTest("tsc", "pass", 9);
		expect(renderAnchorBlock(a.snapshot(), 9)).toEqual([
			"[work-anchor] turn 9",
			"tests: npm test → 7/7 pass, tsc → pass",
		]);
	});
});

describe("renderAnchorBlock — pending section", () => {
	it("lists acceptance targets that have no edit/write yet", () => {
		const a = new WorkAnchor();
		a.recordEdit("README.md", "deadbeef", "+3 -0", 4);
		const lines = renderAnchorBlock(a.snapshot(), 4, ["README.md", "SUBSYSTEM-MAP.md"]);
		expect(lines).toContain("pending: SUBSYSTEM-MAP.md");
	});

	it("omits the pending line when every target has been produced", () => {
		const a = new WorkAnchor();
		a.recordEdit("SUBSYSTEM-MAP.md", "cafef00d", "+80 -0", 5);
		const lines = renderAnchorBlock(a.snapshot(), 5, ["SUBSYSTEM-MAP.md"]);
		expect(lines.some((l) => l.startsWith("pending:"))).toBe(false);
	});

	it("shows pending even before any work has started (header + pending only)", () => {
		const snap = new WorkAnchor().snapshot();
		expect(renderAnchorBlock(snap, 1, ["SUBSYSTEM-MAP.md"])).toEqual([
			"[work-anchor] turn 1",
			"pending: SUBSYSTEM-MAP.md",
		]);
	});

	it("a FAILED edit of a target does NOT clear it — a failed write produced nothing", () => {
		const a = new WorkAnchor();
		a.recordEditFailure("SUBSYSTEM-MAP.md", 3);
		const lines = renderAnchorBlock(a.snapshot(), 3, ["SUBSYSTEM-MAP.md"]);
		expect(lines).toContain("pending: SUBSYSTEM-MAP.md");
		expect(lines).toContain("edits: SUBSYSTEM-MAP.md failed");
	});
});

describe("renderAnchorBlock — full block ordering + determinism", () => {
	it("orders sections read, edits, tests, pending under one header", () => {
		const a = new WorkAnchor();
		a.recordRead("src/z.ts", "abcabc12", 1);
		a.recordEdit("src/y.ts", "def01234", "+1 -1", 2);
		a.recordTest("pnpm test", "3/3 pass", 3);
		expect(renderAnchorBlock(a.snapshot(), 3, ["OUT.md"])).toEqual([
			"[work-anchor] turn 3",
			"read: src/z.ts@abcabc12",
			"edits: src/y.ts +1 -1 hash def01234",
			"tests: pnpm test → 3/3 pass",
			"pending: OUT.md",
		]);
	});

	it("is deterministic: same state renders byte-identically (replacement, not drift)", () => {
		const a = new WorkAnchor();
		a.recordEdit("src/y.ts", "def01234", "+1 -1", 2);
		const first = renderAnchorBlock(a.snapshot(), 5);
		const second = renderAnchorBlock(a.snapshot(), 5);
		expect(second).toEqual(first);
	});
});

describe("anchorTailMessage — volatile tail carrier", () => {
	it("wraps the block lines into a single trailing user message (timestamp 0)", () => {
		const msg = anchorTailMessage(["[work-anchor] turn 2", "edits: a.ts +1 -0 hash aaaa1111"]);
		expect(msg).toEqual({
			role: "user",
			content: "[work-anchor] turn 2\nedits: a.ts +1 -0 hash aaaa1111",
			timestamp: 0,
		});
	});

	it("appends cleanly, leaving the base array as an unchanged prefix", () => {
		const base = [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", content: "ok", timestamp: 2 },
		];
		const lines = ["[work-anchor] turn 3", "pending: OUT.md"];
		const sent = [...base, anchorTailMessage(lines)];
		expect(sent.slice(0, base.length)).toEqual(base);
		expect(sent).toHaveLength(base.length + 1);
	});
});

describe("parseTestResult — bash → test record (mechanical only)", () => {
	it("returns null for a non-test bash command", () => {
		expect(parseTestResult("ls -la", "a\nb\nc", false)).toBeNull();
	});

	it("classifies a vitest run and parses the passed/total count", () => {
		const out = "\n Test Files  3 passed (3)\n      Tests  7 passed (7)\n";
		expect(parseTestResult("npx vitest run", out, false)).toEqual({
			command: "npx vitest run",
			result: "7/7 pass",
		});
	});

	it("falls back to exit status when no count is parseable", () => {
		expect(parseTestResult("npm test", "some custom runner output", false)).toEqual({
			command: "npm test",
			result: "pass",
		});
	});

	it("records a failing test run as fail (non-zero exit / isError)", () => {
		expect(parseTestResult("npm test", "1 failed", true)).toEqual({
			command: "npm test",
			result: "fail",
		});
	});
});

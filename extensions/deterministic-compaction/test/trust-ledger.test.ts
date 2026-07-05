import { describe, it, expect } from "vitest";
import { TrustLedger, hashContent, parseDiffstat } from "../src/trust-ledger.ts";

describe("hashContent — T1 (taucode-aligned SHA-256 / 8-hex)", () => {
	it("is SHA-256 truncated to 8 hex chars", () => {
		// sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
		expect(hashContent("hello")).toBe("2cf24dba");
	});
	it("differs when content differs", () => {
		expect(hashContent("a")).not.toBe(hashContent("b"));
	});
});

describe("TrustLedger — T1 view registration", () => {
	it("records a read view as path -> {hash, turn}", () => {
		const l = new TrustLedger();
		l.recordView("/a.ts", "hello", 5);
		expect(l.get("/a.ts")).toEqual({ hash: "2cf24dba", turn: 5 });
	});
	it("records an edit as path -> {hash, turn, diffstat}", () => {
		const l = new TrustLedger();
		l.recordEdit("/a.ts", "hello", 7, "+1 -0");
		expect(l.get("/a.ts")).toEqual({ hash: "2cf24dba", turn: 7, diffstat: "+1 -0" });
	});
	it("get() returns undefined for an unrecorded path", () => {
		expect(new TrustLedger().get("/nope")).toBeUndefined();
	});
	it("tracks the latest record per path (edit overwrites read)", () => {
		const l = new TrustLedger();
		l.recordView("/a.ts", "hello", 1);
		l.recordEdit("/a.ts", "world", 3, "+1 -1");
		expect(l.get("/a.ts")?.hash).toBe(hashContent("world"));
		expect(l.get("/a.ts")?.turn).toBe(3);
	});
});

describe("parseDiffstat — unified patch → +N -M string", () => {
	it("counts added and removed lines from a unified patch", () => {
		const patch = [
			"--- a/file.ts",
			"+++ b/file.ts",
			"@@ -1,3 +1,4 @@",
			" unchanged",
			"-old line",
			"+new line",
			"+extra line",
			" more unchanged",
		].join("\n");
		expect(parseDiffstat(patch)).toBe("+2 -1");
	});
	it("handles pure addition", () => {
		expect(parseDiffstat("+++ b/file.ts\n+line1\n+line2")).toBe("+2 -0");
	});
	it("handles pure deletion", () => {
		expect(parseDiffstat("--- a/file.ts\n-gone1\n-gone2\n-gone3")).toBe("+0 -3");
	});
	it("returns +0 -0 on empty input", () => {
		expect(parseDiffstat("")).toBe("+0 -0");
	});
});

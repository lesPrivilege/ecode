import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ecode-preflight-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rows(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("R2-preflight harness wiring", () => {
	it("injects file-exists acceptance targets into ECODE_ANCHOR_ACCEPTANCE when the anchor flag is on", () => {
		const out = join(dir, "e1-c.jsonl");
		execFileSync(
			process.execPath,
			[
				"--no-warnings",
				"--experimental-transform-types",
				"--import",
				resolve("lib/register.mjs"),
				resolve("run.ts"),
				"--provider",
				"mock",
				"--scenario",
				"G2-E1",
				"--arm",
				"C",
				"--context-window",
				"12345",
				"--out",
				out,
			],
			{ cwd: resolve("."), encoding: "utf8", env: { ...process.env, ECODE_SEMANTIC_ANCHOR: "1" } },
		);

		const meta = rows(out).find((r) => r.type === "meta")!;
		const mechanism = meta.mechanism as Record<string, unknown>;
		expect(mechanism.provider_context_window).toBe(12345);
		expect(mechanism.anchor_acceptance_targets).toBe("SUBSYSTEM-MAP.md");
	});
});

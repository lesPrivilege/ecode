import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRunArtifacts } from "../lib/artifacts.js";
import { parseAcceptance, type PacketMetadata } from "../lib/packet.js";

let root: string;
let workspace: string;
let snapshot: string;
let results: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ecode-artifacts-"));
	workspace = join(root, "workspace");
	snapshot = join(root, "snapshot");
	results = join(root, "results");
	mkdirSync(join(workspace, "src"), { recursive: true });
	mkdirSync(join(snapshot, "workspace", "src"), { recursive: true });
	mkdirSync(results, { recursive: true });
	writeFileSync(join(snapshot, "workspace", "src", "out.txt"), "before\n", "utf8");
	writeFileSync(join(workspace, "src", "out.txt"), "after\n", "utf8");
	writeFileSync(join(workspace, "ACCEPT.md"), "ok\n", "utf8");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("exportRunArtifacts", () => {
	it("copies reviewable outputs, writes snapshot diff, and logs command checks", () => {
		const packet: PacketMetadata = {
			id: "G2-X",
			title: "G2-X",
			goal: "",
			readFirst: [],
			allowed: ["src/out.txt"],
			nonGoals: [],
			validation: [],
		};
		const acceptance = [
			parseAcceptance("file-exists ACCEPT.md"),
			parseAcceptance("command: node -e \"console.log('ok')\""),
		];
		const outPath = join(results, "G2-X-C.jsonl");
		const manifest = exportRunArtifacts({
			workspace,
			outPath,
			packet,
			acceptance,
			workspaceFrom: snapshot,
		});

		expect(existsSync(join(results, "G2-X-C", "artifact", "outputs", "src", "out.txt"))).toBe(true);
		expect(existsSync(join(results, "G2-X-C", "artifact", "outputs", "ACCEPT.md"))).toBe(true);
		expect(readFileSync(manifest.diff_stat!, "utf8")).toContain("out.txt");
		expect(readFileSync(manifest.diff!, "utf8")).toContain("-before");
		expect(manifest.command_logs).toHaveLength(1);
		expect(readFileSync(manifest.command_logs[0].log, "utf8")).toContain("ok");
		expect(JSON.parse(readFileSync(join(results, "G2-X-C", "artifact", "manifest.json"), "utf8"))).toMatchObject({
			type: "artifact",
			output_files: expect.arrayContaining(["src/out.txt", "ACCEPT.md"]),
		});
	});
});

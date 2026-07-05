/**
 * Artifact export for G3-AR.
 *
 * The run workspace is temporary by design, but round 1 proved that deleting it
 * without a review cache makes quality review impossible. This module snapshots
 * the reviewable parts of a finished run before cleanup: declared output files,
 * acceptance-target files, a final tree, a snapshot-relative diff when possible,
 * and command-check logs. It does not change the acceptance row: command checks
 * remain pending in JSONL, with their real output stored here for review.
 */

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import type { AcceptanceCheck } from "./packet.js";
import type { PacketMetadata } from "./packet.js";

const MAX_DIFF_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ArtifactExportInput {
	workspace: string;
	outPath: string;
	packet: PacketMetadata | null;
	acceptance: AcceptanceCheck[];
	workspaceFrom?: string;
}

export interface ArtifactCommandLog {
	index: number;
	command: string;
	status: number | null;
	signal: string | null;
	timedOut: boolean;
	log: string;
}

export interface ArtifactManifest {
	type: "artifact";
	path: string;
	output_files: string[];
	diff_stat: string | null;
	diff: string | null;
	diff_truncated: boolean;
	command_logs: ArtifactCommandLog[];
}

function runStem(outPath: string): string {
	return basename(outPath).replace(/\.jsonl$/i, "") || "run";
}

function artifactDirFor(outPath: string): string {
	return join(dirname(outPath), runStem(outPath), "artifact");
}

function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeCandidate(raw: string): string | null {
	const fenced = raw.match(/`([^`]+)`/);
	const s = (fenced ? fenced[1] : raw).trim();
	if (!s || s.includes("\n")) return null;
	if (/^(workspace|workspace\s+内)$/i.test(s)) return null;
	return s.replace(/^\.\//, "");
}

function candidatePaths(packet: PacketMetadata | null, acceptance: AcceptanceCheck[]): string[] {
	const out = new Set<string>();
	for (const a of packet?.allowed ?? []) {
		const p = normalizeCandidate(a);
		if (p) out.add(p);
	}
	for (const check of acceptance) {
		if ("path" in check) {
			const p = normalizeCandidate(check.path);
			if (p) out.add(p);
		}
	}
	return [...out].sort();
}

function copyCandidate(workspace: string, artifactDir: string, relPath: string): string | null {
	if (isAbsolute(relPath)) return null;
	const src = resolvePath(workspace, relPath);
	if (!inside(workspace, src) || !existsSync(src)) return null;
	const dest = join(artifactDir, "outputs", relPath);
	mkdirSync(dirname(dest), { recursive: true });
	cpSync(src, dest, { recursive: true, dereference: false });
	return relPath;
}

function listTree(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = join(dir, entry.name);
			const rel = relative(root, abs).split("\\").join("/");
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === ".git") {
					lines.push(`${rel}/`);
					continue;
				}
				lines.push(`${rel}/`);
				walk(abs);
			} else if (entry.isSymbolicLink()) {
				lines.push(`${rel} -> ${readlinkSync(abs)}`);
			} else if (entry.isFile()) {
				lines.push(`${rel} (${statSync(abs).size} bytes)`);
			}
		}
	};
	walk(root);
	return `${lines.join("\n")}\n`;
}

function writeTruncated(path: string, content: string, maxBytes = MAX_DIFF_BYTES): boolean {
	const bytes = Buffer.byteLength(content);
	if (bytes <= maxBytes) {
		writeFileSync(path, content, "utf8");
		return false;
	}
	const buf = Buffer.from(content);
	const head = buf.subarray(0, maxBytes).toString("utf8");
	writeFileSync(path, `${head}\n\n[truncated: ${bytes} bytes > ${maxBytes} byte limit]\n`, "utf8");
	return true;
}

function runGitDiff(args: string[]): { stdout: string; stderr: string; status: number | null } {
	const res = spawnSync("git", args, { encoding: "utf8", maxBuffer: MAX_DIFF_BYTES * 2, timeout: COMMAND_TIMEOUT_MS });
	return {
		stdout: typeof res.stdout === "string" ? res.stdout : "",
		stderr: typeof res.stderr === "string" ? res.stderr : "",
		status: res.status,
	};
}

function writeDiff(
	workspace: string,
	artifactDir: string,
	candidates: readonly string[],
	workspaceFrom?: string,
): Pick<ArtifactManifest, "diff" | "diff_stat" | "diff_truncated"> {
	if (!workspaceFrom) return { diff: null, diff_stat: null, diff_truncated: false };
	const base = resolvePath(workspaceFrom, "workspace");
	if (!existsSync(base)) return { diff: null, diff_stat: null, diff_truncated: false };

	const statPath = join(artifactDir, "diff.stat");
	const diffPath = join(artifactDir, "diff.patch");
	const statParts: string[] = [];
	const diffParts: string[] = [];
	for (const rel of candidates) {
		if (isAbsolute(rel)) continue;
		const before = resolvePath(base, rel);
		const after = resolvePath(workspace, rel);
		if (!inside(base, before) || !inside(workspace, after)) continue;
		if (!existsSync(before) && !existsSync(after)) continue;
		const stat = runGitDiff(["--no-pager", "diff", "--no-index", "--stat", before, after]);
		const diff = runGitDiff(["--no-pager", "diff", "--no-index", before, after]);
		statParts.push(`## ${rel}\n${stat.stdout || stat.stderr || "(no diff)\n"}`);
		diffParts.push(`## ${rel}\n${diff.stdout || diff.stderr || "(no diff)\n"}`);
	}
	writeFileSync(statPath, statParts.length > 0 ? statParts.join("\n") : "(no diff candidates)\n", "utf8");
	const truncated = writeTruncated(diffPath, diffParts.length > 0 ? diffParts.join("\n") : "(no diff candidates)\n");
	return { diff: diffPath, diff_stat: statPath, diff_truncated: truncated };
}

function commandChecks(acceptance: AcceptanceCheck[]): { index: number; command: string }[] {
	const commands: { index: number; command: string }[] = [];
	acceptance.forEach((check, index) => {
		if (check.kind === "command") commands.push({ index: index + 1, command: check.command });
	});
	return commands;
}

function runCommandLogs(workspace: string, artifactDir: string, acceptance: AcceptanceCheck[]): ArtifactCommandLog[] {
	const dir = join(artifactDir, "commands");
	const logs: ArtifactCommandLog[] = [];
	for (const check of commandChecks(acceptance)) {
		mkdirSync(dir, { recursive: true });
		const res = spawnSync(check.command, {
			cwd: workspace,
			shell: true,
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: MAX_DIFF_BYTES,
		});
		const logPath = join(dir, `${String(check.index).padStart(2, "0")}.log`);
		const timedOut = res.error?.message.includes("ETIMEDOUT") ?? false;
		const body = [
			`$ ${check.command}`,
			`status=${res.status ?? "null"} signal=${res.signal ?? "null"} timedOut=${timedOut}`,
			"",
			"## stdout",
			typeof res.stdout === "string" ? res.stdout : "",
			"",
			"## stderr",
			typeof res.stderr === "string" ? res.stderr : "",
			res.error ? `\n## error\n${res.error.message}\n` : "",
		].join("\n");
		writeTruncated(logPath, body);
		logs.push({ index: check.index, command: check.command, status: res.status, signal: res.signal, timedOut, log: logPath });
	}
	return logs;
}

export function exportRunArtifacts(input: ArtifactExportInput): ArtifactManifest {
	const artifactDir = artifactDirFor(input.outPath);
	mkdirSync(artifactDir, { recursive: true });
	writeFileSync(join(artifactDir, "workspace-tree.txt"), listTree(input.workspace), "utf8");

	const candidates = candidatePaths(input.packet, input.acceptance);
	const copied: string[] = [];
	for (const p of candidates) {
		const rel = copyCandidate(input.workspace, artifactDir, p);
		if (rel) copied.push(rel);
	}

	const diff = writeDiff(input.workspace, artifactDir, candidates, input.workspaceFrom);
	const commandLogs = runCommandLogs(input.workspace, artifactDir, input.acceptance);
	const manifest: ArtifactManifest = {
		type: "artifact",
		path: artifactDir,
		output_files: copied,
		...diff,
		command_logs: commandLogs,
	};
	writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
	return manifest;
}

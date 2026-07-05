/**
 * DF-REC post-session review exporter.
 *
 * Usage:
 *   node --experimental-transform-types export-review.ts --session <session.jsonl>
 *        [--ambient-dir experiments/results/ambient] [--out <review.md>]
 *
 * It packages the local pi session path, matching ambient rows, a compact-dash
 * style terminal summary, and trigger markers into one reviewable markdown file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

interface Args {
	session?: string;
	ambientDir: string;
	out?: string;
}

type Row = Record<string, unknown>;

function parseArgs(argv: string[]): Args {
	const args: Args = { ambientDir: "experiments/results/ambient" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--session" && argv[i + 1]) args.session = argv[++i];
		else if (a === "--ambient-dir" && argv[i + 1]) args.ambientDir = argv[++i];
		else if (a === "--out" && argv[i + 1]) args.out = argv[++i];
	}
	return args;
}

function readJsonl(path: string): Row[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l, i) => {
			try {
				return JSON.parse(l) as Row;
			} catch (e) {
				throw new Error(`${path}:${i + 1}: invalid JSONL: ${e instanceof Error ? e.message : String(e)}`);
			}
		});
}

function sessionIdFromPath(path: string): string {
	const stem = basename(path).replace(/\.jsonl$/i, "");
	const matches = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
	return matches ? matches[matches.length - 1] : stem;
}

function sessionIdFromRows(rows: Row[], fallbackPath: string): string {
	for (let i = rows.length - 1; i >= 0; i--) {
		const v = rows[i].session_id;
		if (typeof v === "string" && v.length > 0) {
			const matches = v.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
			return matches ? matches[matches.length - 1] : v;
		}
	}
	return sessionIdFromPath(fallbackPath);
}

function num(row: Row | undefined, key: string): number | null {
	const v = row?.[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmt(n: number | null): string {
	return n === null ? "null" : Math.round(n).toLocaleString("en-US");
}

function defaultOut(sessionId: string): string {
	return join("experiments", "results", "reviews", `${sessionId}.md`);
}

function dashProxy(latest: Row | undefined): string {
	if (!latest) return "No ambient rows found; compact-dash proxy unavailable.";
	const turns = num(latest, "turn_count");
	const projected = num(latest, "projected_turn_count");
	const saved = num(latest, "total_compacted_path_re_reads");
	const ch = num(latest, "total_cache_read_tokens");
	return [
		`Turns: ${fmt(turns)}`,
		`Triggers/projected turns: ${fmt(projected)}`,
		`Compacted-path re-reads: ${fmt(saved)}`,
		`Cache read tokens: ${fmt(ch)}`,
		`Trust protocol: ${latest.trust_protocol_enabled === true ? "on" : "off"}`,
	].join("\n");
}

function triggerMarkers(rows: Row[]): string[] {
	const markers: string[] = [];
	let lastProjected = 0;
	for (const row of rows) {
		const projected = num(row, "projected_turn_count") ?? lastProjected;
		if (projected > lastProjected) {
			markers.push(`- ${String(row.written_at ?? "(unknown time)")}: projected_turn_count ${lastProjected} -> ${projected}`);
		}
		lastProjected = projected;
	}
	return markers;
}

function renderReview(sessionPath: string, sessionId: string, ambientPath: string, ambientRows: Row[]): string {
	const latest = ambientRows[ambientRows.length - 1];
	const markers = triggerMarkers(ambientRows);
	const lines: string[] = [];
	lines.push(`# Session review — ${sessionId}`);
	lines.push("");
	lines.push(`- session_jsonl: \`${sessionPath}\``);
	lines.push(`- ambient_jsonl: \`${ambientPath}\`${existsSync(ambientPath) ? "" : " (missing)"}`);
	lines.push(`- ambient_rows: ${ambientRows.length}`);
	lines.push("");
	lines.push("## Compact Dash Final (Offline Proxy)");
	lines.push("");
	lines.push("```text");
	lines.push(dashProxy(latest));
	lines.push("```");
	lines.push("");
	lines.push("## Trigger Markers");
	lines.push("");
	lines.push(...(markers.length > 0 ? markers : ["- none"]));
	lines.push("");
	lines.push("## Ambient Rows");
	lines.push("");
	lines.push("```jsonl");
	for (const row of ambientRows) lines.push(JSON.stringify(row));
	lines.push("```");
	lines.push("");
	lines.push("## Token Accounting");
	lines.push("");
	lines.push("- F-A compactable/content-saved and full context/cache are separate fields; do not mix them.");
	lines.push("- This review is local-only and generated from existing JSONL files.");
	lines.push("");
	return lines.join("\n");
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (!args.session) {
		// eslint-disable-next-line no-console
		console.error("export-review requires --session <session.jsonl>");
		process.exit(1);
	}
	const sessionPath = isAbsolute(args.session) ? args.session : resolvePath(process.cwd(), args.session);
	const sessionRows = readJsonl(sessionPath);
	const sessionId = sessionIdFromRows(sessionRows, sessionPath);
	const ambientDir = isAbsolute(args.ambientDir) ? args.ambientDir : resolvePath(process.cwd(), args.ambientDir);
	const ambientPath = join(ambientDir, `${sessionId}.jsonl`);
	const outPath = isAbsolute(args.out ?? "") ? (args.out as string) : resolvePath(process.cwd(), args.out ?? defaultOut(sessionId));
	const review = renderReview(sessionPath, sessionId, ambientPath, readJsonl(ambientPath));
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, review, "utf8");
	// eslint-disable-next-line no-console
	console.log(outPath);
}

main();

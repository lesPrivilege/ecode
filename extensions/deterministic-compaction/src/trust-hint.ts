import type { Message } from "./compaction-core.js";
import { hashContent, type TrustLedger } from "./trust-ledger.js";

function readPathFromArgs(args: unknown): string | undefined {
	if (typeof args === "object" && args !== null && "path" in args) {
		const p = (args as { path?: unknown }).path;
		return typeof p === "string" ? p : undefined;
	}
	return undefined;
}

/**
 * V2-TP task 3 — mismatch-hint lines for stale READ views.
 *
 * Scans core messages for read tool results, pairs each to its read tool-call
 * (for the path), and compares the view's content hash to the ledger's current
 * hash. A hint fires only when the path has an EDIT in the ledger (diffstat
 * present — "predates your edit" must be truthful) and the view hash differs.
 * Read views only (bash excluded, per ruling); at most one hint per path.
 *
 * Pure and side-effect free: returns the lines; the caller places them in the
 * volatile send-time tail (never in the session, never breaking the prefix).
 */
export function staleViewHints(messages: Message[], ledger: TrustLedger): string[] {
	const readCallPath = new Map<string, string>();
	for (const m of messages) {
		if (m.role === "assistant" && m.toolCalls) {
			for (const tc of m.toolCalls) {
				if (tc.name === "read") {
					const path = readPathFromArgs(tc.arguments);
					if (path) readCallPath.set(tc.id, path);
				}
			}
		}
	}

	const hints: string[] = [];
	const seen = new Set<string>();
	for (const m of messages) {
		if (m.role !== "tool" || m.toolName !== "read" || !m.toolCallId) continue;
		const path = readCallPath.get(m.toolCallId);
		if (!path || seen.has(path)) continue;
		const entry = ledger.get(path);
		if (!entry || entry.diffstat === undefined) continue; // only edited paths
		const birthHash = hashContent(m.content ?? "");
		if (birthHash === entry.hash) continue; // view is current
		seen.add(path);
		hints.push(
			`[stale-view] ${path}: view from ${birthHash} predates your edit at turn ${entry.turn} (now ${entry.hash}); re-read only if you need current content.`,
		);
	}
	return hints;
}

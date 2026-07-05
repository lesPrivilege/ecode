import { createHash } from "node:crypto";

/**
 * V2-TP trust ledger (task 1 + 2). Session-scoped, in-memory record of the
 * latest content hash per path, populated from read/bash results (views) and
 * edit/write results (evidence). Never persisted, never mutates the tool result
 * itself. All use sits behind ECODE_TRUST_PROTOCOL.
 */

/** SHA-256 of the content, truncated to 8 hex chars (taucode hashline alignment). */
export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

export interface LedgerEntry {
	/** SHA-256/8-hex of the content at record time (the current authoritative hash). */
	hash: string;
	/** Turn the entry was recorded. */
	turn: number;
	/** Present on edit/write records — the model's physical evidence of its own change. */
	diffstat?: string;
}

/**
 * Parse a unified diff/patch into a "+N -M" diffstat string.
 * Counts only content lines (skips --- / +++ header lines).
 */
export function parseDiffstat(patch: string): string {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return `+${added} -${removed}`;
}

export class TrustLedger {
	private readonly byPath = new Map<string, LedgerEntry>();

	/** Record a read/bash view: path -> {hash, turn}. */
	recordView(path: string, content: string, turn: number): void {
		this.byPath.set(path, { hash: hashContent(content), turn });
	}

	/** Record an edit/write: path -> {hash, turn, diffstat} (post-write hash). */
	recordEdit(path: string, content: string, turn: number, diffstat: string): void {
		this.byPath.set(path, { hash: hashContent(content), turn, diffstat });
	}

	/** The latest ledger entry for a path, or undefined if never recorded. */
	get(path: string): LedgerEntry | undefined {
		return this.byPath.get(path);
	}
}

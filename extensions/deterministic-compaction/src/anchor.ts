/**
 * V3-WS task 1 — work-semantic anchor block.
 *
 * A deterministic, LLM-free record of "what have I done / where am I" derived
 * ENTIRELY from tool events. When a projection fires (and only then), the anchor
 * block is injected into the volatile send-time tail — the same channel and prefix
 * discipline as the V2-TP stale-view hint (send-time only, never persisted, one
 * block per turn, replacement not append).
 *
 * Motivation (docs/reports/g2-round1-verdict.md): E1-C projected 26 times yet the
 * required `SUBSYSTEM-MAP.md` was never produced — work semantics were lost across
 * projections. The anchor re-states the mechanically verifiable facts the model
 * would otherwise have to reconstruct: files read + hash, edits + diffstat + hash,
 * tests run + result, and pending acceptance targets.
 *
 * Trust discipline (packet 禁区): every line is a mechanically verifiable fact.
 * No evaluative or inferential language ("progress is good", "almost done"). A
 * failed edit is recorded as failed, never dressed up.
 *
 * The hash/diffstat values are computed once in the tool_result wiring (reusing
 * trust-ledger's hashContent/parseDiffstat) and handed in here — this module never
 * re-derives them.
 */

export interface AnchorReadRecord {
	path: string;
	/** Content hash of the read view (trust-ledger hashContent). */
	hash: string;
	turn: number;
}

export interface AnchorEditRecord {
	path: string;
	/** Post-write content hash; null for a failed edit. */
	hash: string | null;
	/** "+N -M" diffstat; null for a failed edit. */
	diffstat: string | null;
	/** Hash the path held before this edit (from an earlier read/edit), if known. */
	priorHash?: string;
	turn: number;
	failed: boolean;
}

export interface AnchorTestRecord {
	command: string;
	result: string;
	turn: number;
}

export interface AnchorSnapshot {
	reads: AnchorReadRecord[];
	edits: AnchorEditRecord[];
	tests: AnchorTestRecord[];
}

/**
 * Session-scoped accumulator of work facts, fed by the tool_result wiring. Latest
 * state per path for reads/edits; an append log for tests. Never persisted; lives
 * only as long as the extension install (mirrors TrustLedger's lifecycle).
 */
export class WorkAnchor {
	private readonly reads = new Map<string, AnchorReadRecord>();
	private readonly edits = new Map<string, AnchorEditRecord>();
	private readonly tests: AnchorTestRecord[] = [];

	/** Record a read view: path -> {hash, turn}. */
	recordRead(path: string, hash: string, turn: number): void {
		this.reads.set(path, { path, hash, turn });
	}

	/** Record a successful edit/write: post-write hash + diffstat, capturing the prior hash if known. */
	recordEdit(path: string, hash: string, diffstat: string, turn: number): void {
		const prior = this.edits.get(path)?.hash ?? this.reads.get(path)?.hash;
		this.edits.set(path, { path, hash, diffstat, priorHash: prior ?? undefined, turn, failed: false });
	}

	/** Record a failed edit/write honestly — no hash, no diffstat. */
	recordEditFailure(path: string, turn: number): void {
		this.edits.set(path, { path, hash: null, diffstat: null, turn, failed: true });
	}

	/** Record a test run: command + parsed result (see {@link parseTestResult}). */
	recordTest(command: string, result: string, turn: number): void {
		this.tests.push({ command, result, turn });
	}

	snapshot(): AnchorSnapshot {
		return {
			reads: [...this.reads.values()],
			edits: [...this.edits.values()],
			tests: [...this.tests],
		};
	}
}

function byPath<T extends { path: string }>(a: T, b: T): number {
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Render the sectioned anchor block from a snapshot. Sections appear in a fixed
 * order (read, edits, tests, pending) under one `[work-anchor] turn N` header.
 * A path that was edited appears only in `edits` (never duplicated under `read`).
 * `pending` = acceptance targets with no edit/write record yet.
 *
 * Returns `[]` when there is nothing to anchor (no work AND no pending), so the
 * caller can skip injection entirely. Pure and deterministic: same snapshot +
 * turn + targets → byte-identical output (the replacement-update property).
 */
export function renderAnchorBlock(snap: AnchorSnapshot, turn: number, acceptanceTargets?: string[]): string[] {
	const editedPaths = new Set(snap.edits.map((e) => e.path));
	const lines: string[] = [`[work-anchor] turn ${turn}`];

	const readOnly = snap.reads.filter((r) => !editedPaths.has(r.path)).sort(byPath);
	if (readOnly.length > 0) {
		lines.push(`read: ${readOnly.map((r) => `${r.path}@${r.hash}`).join(", ")}`);
	}

	const edits = [...snap.edits].sort(byPath);
	if (edits.length > 0) {
		lines.push(
			`edits: ${edits
				.map((e) =>
					e.failed
						? `${e.path} failed`
						: `${e.path} ${e.diffstat} hash ${e.priorHash ? `${e.priorHash}→${e.hash}` : e.hash}`,
				)
				.join(", ")}`,
		);
	}

	if (snap.tests.length > 0) {
		lines.push(`tests: ${snap.tests.map((t) => `${t.command} → ${t.result}`).join(", ")}`);
	}

	// A target is satisfied only by a SUCCESSFUL edit/write — a failed attempt
	// produced nothing, so it must stay pending (the whole point of the reminder).
	const producedPaths = new Set(snap.edits.filter((e) => !e.failed).map((e) => e.path));
	const pending = (acceptanceTargets ?? []).filter((t) => !producedPaths.has(t));
	if (pending.length > 0) {
		lines.push(`pending: ${pending.join(", ")}`);
	}

	return lines.length > 1 ? lines : [];
}

/**
 * The volatile-tail message carrying the anchor block. A minimal pi user message
 * (role/content/timestamp); the caller APPENDS it to the outgoing send array so
 * the existing prefix stays byte-stable and it is never persisted. Mirrors
 * {@link staleHintMessage} exactly so the two tail carriers coexist cleanly.
 */
export function anchorTailMessage(lines: string[]): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: lines.join("\n"), timestamp: 0 };
}

/** Command shapes we recognise as test runs (mechanical classification, no inference). */
const TEST_COMMAND =
	/\b(vitest|jest|pytest|mocha|(?:npm|pnpm|yarn|bun|npx)\s+(?:run\s+)?test|go\s+test|cargo\s+test)\b/;

/**
 * Classify a bash command as a test run and derive a mechanical result:
 *   - not a test command                → null (nothing recorded)
 *   - isError (non-zero exit)           → "fail"
 *   - a parseable "N passed (M)" count  → "N/M pass"
 *   - otherwise                         → "pass" (exit status only)
 *
 * Deliberately conservative: only exit status and explicit runner counts, never a
 * guess about which tests or why.
 */
export function parseTestResult(
	command: string,
	output: string,
	isError: boolean,
): { command: string; result: string } | null {
	if (!TEST_COMMAND.test(command)) return null;
	if (isError) return { command, result: "fail" };
	const m =
		output.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/) ?? output.match(/(\d+)\s+passed[^0-9]+(\d+)\s+total/);
	if (m) return { command, result: `${m[1]}/${m[2]} pass` };
	return { command, result: "pass" };
}

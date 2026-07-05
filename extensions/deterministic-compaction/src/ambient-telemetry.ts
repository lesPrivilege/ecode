/**
 * Ambient telemetry (DF1, task 3).
 *
 * While the extension runs INSIDE a real pi session (dogfooding), it records one
 * G1c-schema-shaped JSONL row per session capturing what the compaction path
 * actually did: token counts, tool-call / re-read counts, the compacted-path
 * re-read RATE (the metric that would have caught taucode's false-savings case),
 * and cache hit/miss (null when the provider gives no signal).
 *
 * ---------------------------------------------------------------------------
 * SCHEMA MIRRORING (deliberate duplication, NOT an import)
 * ---------------------------------------------------------------------------
 * The row shape mirrors `experiments/lib/metrics.ts`'s `SummaryRow` so this data
 * is analysable the same way G1c/G2 data is (compare.ts reads plain top-level
 * numbers without knowing the producer). Per the DF1 packet we MUST NOT create a
 * runtime dependency from extensions/ to experiments/, so the field names/shapes
 * are re-declared here rather than imported. `schema_family` records the lineage
 * so a reader can tell an ambient row from an arm-run summary row.
 *
 * Field parity with metrics.ts SummaryRow (the analysable core):
 *   total_input_tokens, total_output_tokens, total_tool_calls, total_read_calls,
 *   total_re_reads, compacted_path_count, total_compacted_path_re_reads,
 *   compacted_path_re_read_rate, projected_turn_count, total_cache_read_tokens,
 *   cache_signal_present, turn_count, session_id.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY (non-negotiable — see DF1 packet)
 * ---------------------------------------------------------------------------
 * These rows are derived from real code content the agent handled and are
 * therefore potentially sensitive. This module:
 *   - writes ONLY to the local filesystem (a plain fs.appendFile); there is NO
 *     network path here and none must ever be added;
 *   - targets `experiments/results/ambient/` which is gitignored (verified in
 *     tests) so rows are never committed;
 *   - records COUNTS and TOKEN ESTIMATES, never file bodies or paths.
 *
 * ---------------------------------------------------------------------------
 * DF2 REUSE
 * ---------------------------------------------------------------------------
 * `appendAmbientRow` is the single, exported "append one row to the ambient
 * JSONL" primitive. A closely related future goal (DF2, tuning) will log its own
 * events into the SAME file/schema family by calling this exact function with a
 * different `type`. Do not inline this logic anywhere else.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Schema-family tag stamped on every ambient row so its lineage is auditable. */
export const AMBIENT_SCHEMA_FAMILY = "g1c-ambient";
/** Bump when the row shape changes in a breaking way. */
export const AMBIENT_SCHEMA_VERSION = 1;

/**
 * One ambient session-summary row. Every numeric field is a plain top-level
 * number (or null) so the tolerant G1c/G2 reader consumes it unchanged; the
 * field names are a strict subset-with-parity of metrics.ts `SummaryRow`.
 *
 * `type: "session"` distinguishes an ambient dogfood row from the arm-run
 * `type: "summary"` rows; DF2 will add sibling rows with other `type` values in
 * this same schema family (e.g. `type: "tuning"`).
 */
export interface AmbientSessionRow {
	type: "session";
	schema_family: string;
	schema_version: number;
	/** ISO-8601 timestamp the row was written. */
	written_at: string;
	/** pi session id (also the JSONL filename stem). */
	session_id: string;
	/** Number of LLM calls (turns) observed this session. */
	turn_count: number;
	/** Estimated tokens of the OUTGOING (post-projection) payloads, summed. */
	total_input_tokens: number;
	/** OUTPUT tokens from provider usage, else estimated from assistant text. */
	total_output_tokens: number;
	/** All tool calls issued across the session. */
	total_tool_calls: number;
	/** `read` tool calls across the session. */
	total_read_calls: number;
	/** Reads targeting a path already read earlier in the session. */
	total_re_reads: number;
	/** Distinct paths whose read RESULT was compacted at least once. */
	compacted_path_count: number;
	/** Reads (at any later turn) targeting an already-compacted path. */
	total_compacted_path_re_reads: number;
	/**
	 * compacted_path_re_reads / total_read_calls, or null when there were no
	 * reads. Denominator is total reads (stable, always-defined base) — matches
	 * metrics.ts so the two data families compare directly.
	 */
	compacted_path_re_read_rate: number | null;
	/** Turns on which seam-A projected (compacted) the outgoing payload. */
	projected_turn_count: number;
	/** Total cacheRead across turns; null when NO turn carried a signal. */
	total_cache_read_tokens: number | null;
	/** Whether ANY turn carried a cacheRead signal (drives null-vs-0). */
	cache_signal_present: boolean;
}

/**
 * A generic ambient row: the session summary today, and whatever sibling row
 * types DF2 adds tomorrow. The writer only requires the common envelope fields;
 * everything else is pass-through so DF2 need not touch this file.
 */
export interface AmbientRowEnvelope {
	type: string;
	schema_family: string;
	schema_version: number;
	written_at: string;
	session_id: string;
	[extra: string]: unknown;
}

export type AmbientRow = AmbientSessionRow | AmbientRowEnvelope;

export interface AppendAmbientRowOptions {
	/**
	 * Directory that holds one JSONL file per session. Defaults to
	 * `<repoRoot>/experiments/results/ambient` resolved from this module's
	 * location. Override in tests to point at a temp dir.
	 */
	dir?: string;
	/**
	 * Filename stem (without extension). Defaults to the row's `session_id`.
	 * The file is `<dir>/<stem>.jsonl` and rows are APPENDED (one session may
	 * flush more than once — e.g. on agent_end and again on shutdown; DF2 may add
	 * tuning rows mid-session — so append, never truncate).
	 */
	fileStem?: string;
}

/**
 * Resolve the default ambient output directory: `experiments/results/ambient`
 * under the ecode repo root. This module lives at
 * `extensions/deterministic-compaction/src/ambient-telemetry.ts`, so the repo
 * root is three levels up from `src`. Kept as a function (not a const) so tests
 * can assert the path without importing node internals at module scope.
 *
 * `ECODE_AMBIENT_DIR` overrides the target when set — used by the test suite to
 * redirect ambient writes to a throwaway dir so real dogfood data in
 * `experiments/results/ambient/` is never touched by tests. Real runs leave it
 * unset and get the true default.
 */
export function defaultAmbientDir(): string {
	const override = process.env.ECODE_AMBIENT_DIR;
	if (override && override.trim() !== "") return override;
	// .../extensions/deterministic-compaction/src -> repo root is ../../../
	const here = dirname(fileURLToPathSafe(import.meta.url));
	return resolve(here, "..", "..", "..", "experiments", "results", "ambient");
}

/**
 * `import.meta.url` -> filesystem path, without a static top-level import of
 * `node:url` (keeps the module import graph minimal for jiti/vitest). Falls back
 * to stripping the `file://` prefix if the dynamic import is unavailable.
 */
function fileURLToPathSafe(url: string): string {
	try {
		// Lazy require avoids a hard dependency at module-eval time.
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { fileURLToPath } = require("node:url") as typeof import("node:url");
		return fileURLToPath(url);
	} catch {
		return url.startsWith("file://") ? decodeURIComponent(url.slice("file://".length)) : url;
	}
}

/**
 * Append ONE row to the ambient JSONL for a session. Local-only, synchronous,
 * creates the directory on first write. This is the DF2-reusable primitive.
 *
 * Returns the absolute path of the file written (useful for tests / logging).
 *
 * SIGNATURE IS LOAD-BEARING FOR DF2:
 *   appendAmbientRow(row: AmbientRow, opts?: AppendAmbientRowOptions): string
 */
export function appendAmbientRow(row: AmbientRow, opts: AppendAmbientRowOptions = {}): string {
	const dir = opts.dir ?? defaultAmbientDir();
	const stem = opts.fileStem ?? row.session_id;
	const filePath = isAbsolute(stem) ? stem : join(dir, `${sanitizeStem(stem)}.jsonl`);
	const targetDir = dirname(filePath);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true });
	}
	appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf-8");
	return filePath;
}

/** Keep the filename filesystem-safe; session ids are already tame but be defensive. */
function sanitizeStem(stem: string): string {
	return stem.replace(/[^A-Za-z0-9._-]/g, "_") || "session";
}

// ---------------------------------------------------------------------------
// AmbientCollector — accumulates the session's counts and emits an AmbientSessionRow
// ---------------------------------------------------------------------------

/** Minimal read of an assistant message: its text and its read-call paths. */
export interface AssistantLike {
	role: "assistant";
	content: Array<{ type: string; [k: string]: unknown }>;
	usage?: { output?: number; cacheRead?: number };
}

/**
 * Accumulates ambient counts across a session. Mirrors the accounting in
 * metrics.ts `RunMetrics` (same formulas: re_read, compacted_paths,
 * compacted_path_re_read_rate) but is standalone (no experiments/ import).
 *
 * Wiring (done in extension.ts):
 *   - `onTurn(sentInputTokens, projectedThisTurn, compactedReadPaths)` once per
 *     `context` hook firing, with the estimate of the payload pi will SEND and
 *     whether seam-A projected it (plus the read paths whose result it compacted);
 *   - `recordAssistant(message)` once per assistant response, to advance
 *     re-read / compacted-path tracking on the calls the model just issued and to
 *     tally output/usage/cache.
 */
export class AmbientCollector {
	private turnCount = 0;
	private totalInputTokens = 0;
	private totalOutputTokens = 0;
	private totalToolCalls = 0;
	private totalReadCalls = 0;
	private totalReReads = 0;
	private totalCompactedPathReReads = 0;
	private projectedTurnCount = 0;
	private cacheTotal = 0;
	private cacheSignalPresent = false;

	private readonly seenReadPaths = new Set<string>();
	private readonly compactedPaths = new Set<string>();

	// per-turn scratch, set by onTurn, consumed by recordAssistant.
	private pendingInputTokens = 0;
	private pendingProjected = false;

	/**
	 * Record the input-token estimate for the payload that will ACTUALLY be sent
	 * this turn (post-projection for a projecting turn), whether seam-A projected,
	 * and the read paths whose RESULT was compacted this turn (so later reads of
	 * them count as compacted-path reads).
	 */
	onTurn(sentInputTokens: number, projectedThisTurn: boolean, compactedReadPaths: readonly string[]): void {
		this.pendingInputTokens = sentInputTokens;
		this.pendingProjected = projectedThisTurn;
		if (projectedThisTurn) this.projectedTurnCount++;
		for (const p of compactedReadPaths) this.compactedPaths.add(p);
	}

	/**
	 * Record the assistant message for a turn. Advances re-read / compacted-path
	 * tracking using the read calls the model issued in THIS message, and tallies
	 * output tokens + cache signal.
	 */
	recordAssistant(message: AssistantLike): void {
		this.turnCount++;
		this.totalInputTokens += this.pendingInputTokens;

		let toolCalls = 0;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			toolCalls++;
			const name = (block as { name?: unknown }).name;
			if (name !== "read") continue;
			this.totalReadCalls++;
			const args = (block as { arguments?: { path?: unknown } }).arguments;
			const path = typeof args?.path === "string" ? args.path : "<unknown>";
			if (this.compactedPaths.has(path)) this.totalCompactedPathReReads++;
			if (this.seenReadPaths.has(path)) {
				this.totalReReads++;
			} else {
				this.seenReadPaths.add(path);
			}
		}
		this.totalToolCalls += toolCalls;

		const usage = message.usage;
		const hasOutputUsage = !!usage && typeof usage.output === "number" && usage.output > 0;
		this.totalOutputTokens += hasOutputUsage ? (usage!.output as number) : Math.ceil(assistantText(message) / 4);

		// cacheRead: treat as a signal only when the provider populated a finite
		// value. A mock provider emitting cacheRead:0 with no real cache is NOT a
		// signal (kept null); a real provider's prompt_cache_hit maps here.
		if (usage && typeof usage.cacheRead === "number" && usage.cacheRead > 0) {
			this.cacheSignalPresent = true;
			this.cacheTotal += usage.cacheRead;
		}

		this.pendingInputTokens = 0;
		this.pendingProjected = false;
	}

	/** True once any turn has been recorded (so we don't flush an empty session). */
	hasData(): boolean {
		return this.turnCount > 0;
	}

	/** Build the JSONL row for this session. */
	buildRow(sessionId: string): AmbientSessionRow {
		const rate = this.totalReadCalls > 0 ? this.totalCompactedPathReReads / this.totalReadCalls : null;
		return {
			type: "session",
			schema_family: AMBIENT_SCHEMA_FAMILY,
			schema_version: AMBIENT_SCHEMA_VERSION,
			written_at: new Date().toISOString(),
			session_id: sessionId,
			turn_count: this.turnCount,
			total_input_tokens: this.totalInputTokens,
			total_output_tokens: this.totalOutputTokens,
			total_tool_calls: this.totalToolCalls,
			total_read_calls: this.totalReadCalls,
			total_re_reads: this.totalReReads,
			compacted_path_count: this.compactedPaths.size,
			total_compacted_path_re_reads: this.totalCompactedPathReReads,
			compacted_path_re_read_rate: rate,
			projected_turn_count: this.projectedTurnCount,
			total_cache_read_tokens: this.cacheSignalPresent ? this.cacheTotal : null,
			cache_signal_present: this.cacheSignalPresent,
		};
	}
}

/** Total text length of an assistant message's text blocks (for the token estimate). */
function assistantText(message: AssistantLike): number {
	let chars = 0;
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") chars += text.length;
	}
	return chars;
}

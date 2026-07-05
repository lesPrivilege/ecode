/**
 * SYNTHETIC SMOKE FIXTURE — not a real G2 workload.
 *
 * A read-modify "refactor" script that deliberately exercises every metric the
 * harness records:
 *   - large write args + large read results (so seam-A compaction has something to
 *     summarise once the token threshold is crossed);
 *   - growing context: each assistant turn reports a `usage.totalTokens` that
 *     TRACKS the real accumulating content (roughly the content-based estimate at
 *     that point). Two reasons it is seeded rather than left unset:
 *       (i)  arm B's native auto-compaction only engages when it has usage data to
 *            read (agent-session.ts _checkCompaction returns early when
 *            lastUsageIndex === null), so without usage arm B can never fire and
 *            would always be flagged `invalid`;
 *       (ii) the seeded usage sits on the ASSISTANT message, while the big read
 *            RESULT trails it, so estimateContextTokens = usage + trailing-read
 *            estimate stays compaction-SENSITIVE (compacting the trailing read
 *            still drops the estimate) — the sweep remains demonstrable.
 *     Values track real content so the numbers are honest, not inflated. The
 *     mock's cache signal stays absent -> cache_read_tokens null, as intended;
 *   - a DELIBERATE re-read of an earlier-touched path (`mod-a.ts` is read in
 *     turn 2, then read AGAIN in turn 8) so re-read tracking and the
 *     compacted-path-re-read metric are actually driven;
 *   - enough turns (10 LLM calls) that the invalid/suspicious gates have real
 *     signal rather than a trivial 3-turn no-op.
 *
 * The script is model-free and deterministic: identical inputs → identical run.
 */

import type { Scenario } from "../lib/scenario.js";
import { text, toolCall, type ScriptedStep } from "../lib/compaction-core-adapter.js";

/** A big file body — large enough that its write args / read result exceed the
 *  compaction size thresholds (minArgTokens=800, minResultTokens=200). */
function bigModule(tag: string, lines = 320): string {
	return Array.from(
		{ length: lines },
		(_, i) => `export const ${tag}_item_${i} = { id: ${i}, tag: "${tag}", name: "entry-${i}", payload: "xxxxxxxxxxxxxxxxxxxxxxxx-${i}" };`,
	).join("\n");
}

const MOD_A = bigModule("a");
const MOD_B = bigModule("b");
const MOD_C = bigModule("c");

// usage.totalTokens tracks the real accumulating content (see header). It sits on
// the assistant message; the big read result trails it, so the estimate stays
// compaction-sensitive. Output is a small constant.
function usage(total: number) {
	return { input: total, output: 8, totalTokens: total };
}

const steps: ScriptedStep[] = [
	// 1: create mod-a (big write)
	{ content: [text("Creating mod-a.ts."), toolCall("c1-write-a", "write", { path: "mod-a.ts", content: MOD_A })], usage: usage(300) },
	// 2: read mod-a back (big read result) — first read of mod-a
	{ content: [text("Reading mod-a.ts."), toolCall("c2-read-a", "read", { path: "mod-a.ts" })], usage: usage(9000) },
	// 3: create mod-b (big write)
	{ content: [text("Creating mod-b.ts."), toolCall("c3-write-b", "write", { path: "mod-b.ts", content: MOD_B })], usage: usage(17800) },
	// 4: read mod-b (big read) — first read of mod-b
	{ content: [text("Reading mod-b.ts."), toolCall("c4-read-b", "read", { path: "mod-b.ts" })], usage: usage(27000) },
	// 5: create mod-c (big write); native (arm B, window 48000, reserve 16384 -> ~31.6k) fires around here
	{ content: [text("Creating mod-c.ts."), toolCall("c5-write-c", "write", { path: "mod-c.ts", content: MOD_C })], usage: usage(35800) },
	// 6: read mod-c (big read) — first read of mod-c
	{ content: [text("Reading mod-c.ts."), toolCall("c6-read-c", "read", { path: "mod-c.ts" })], usage: usage(44000) },
	// 7: edit mod-b
	{
		content: [
			text("Editing mod-b.ts."),
			toolCall("c7-edit-b", "edit", {
				path: "mod-b.ts",
				oldText: 'export const b_item_0 = { id: 0, tag: "b", name: "entry-0", payload: "xxxxxxxxxxxxxxxxxxxxxxxx-0" };',
				newText: 'export const b_item_0 = { id: 0, tag: "b", name: "entry-0-renamed", payload: "xxxxxxxxxxxxxxxxxxxxxxxx-0" };',
			}),
		],
		usage: usage(50000),
	},
	// 8: RE-READ mod-a.ts — the deliberate re-read of an earlier-touched path.
	//    By now mod-a's turn-2 read result is outside the keep-recent window, so
	//    under seam-A it will have been compacted; this read targets a compacted
	//    path -> drives compacted_path_re_reads.
	{ content: [text("Re-reading mod-a.ts to double-check."), toolCall("c8-reread-a", "read", { path: "mod-a.ts" })], usage: usage(53000) },
	// 9: edit mod-a based on the re-read
	{
		content: [
			text("Editing mod-a.ts."),
			toolCall("c9-edit-a", "edit", {
				path: "mod-a.ts",
				oldText: 'export const a_item_5 = { id: 5, tag: "a", name: "entry-5", payload: "xxxxxxxxxxxxxxxxxxxxxxxx-5" };',
				newText: 'export const a_item_5 = { id: 5, tag: "a", name: "entry-5-fixed", payload: "xxxxxxxxxxxxxxxxxxxxxxxx-5" };',
			}),
		],
		usage: usage(56000),
	},
	// 10: done
	{ content: [text("Refactor complete. mod-a, mod-b, mod-c updated.")], stopReason: "stop", usage: usage(58000) },
];

export const scenarioRefactor: Scenario = {
	id: "refactor",
	description:
		"read-modify refactor across three big modules with a deliberate re-read of mod-a.ts; rising usage crosses the 32000-token threshold mid-run",
	prompt: "Create mod-a.ts, mod-b.ts, mod-c.ts, review them, then refactor mod-a and mod-b. Re-read mod-a before editing it.",
	steps,
};

export default scenarioRefactor;

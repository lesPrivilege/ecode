/**
 * Seam B — deterministic, self-contained compaction checkpoint (OPTIONAL).
 *
 * pi's `session_before_compact` hook may return `{compaction}` to replace pi's
 * default LLM summarisation (agent-harness.ts:707-710). This builds that
 * `CompactionResult` deterministically — no model call — by enumerating the
 * code productions (write/edit) and file reads in the messages being compacted
 * and emitting a plain-text manifest.
 *
 * Correction #3: once persisted with `fromHook: true`, pi will NOT re-derive
 * file-ops from this entry's details on the next compaction pass
 * (compaction.ts guards `if (!prevCompaction.fromHook && prevCompaction.details)`).
 * The manifest is therefore written to be fully self-contained: every path,
 * size, and action a later reader needs is spelled out in `summary` text; we do
 * not rely on pi reading anything back out of `details`.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall as PiToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CompactionOptions } from "./compaction-core.js";

/** pi's CompactionResult shape (agent/harness/compaction/compaction.ts). */
export interface PiCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

export interface SeamBInput {
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary?: string;
	compactionOptions?: Partial<CompactionOptions>;
}

interface CodeProductionEntry {
	tool: string;
	path?: string;
	argChars: number;
}

interface ReadEntry {
	path?: string;
	resultChars: number;
	resultLines: number;
}

function isAssistant(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant";
}
function isToolResult(m: AgentMessage): m is ToolResultMessage {
	return m.role === "toolResult";
}

function toolResultText(content: ToolResultMessage["content"]): string {
	return content.map((b) => (b.type === "text" ? b.text : `[image:${b.mimeType}]`)).join("\n");
}

/**
 * Enumerate code productions and reads from the messages being compacted, then
 * render a self-contained checkpoint summary. Deterministic: identical input
 * yields byte-identical output.
 */
export function buildSeamBCheckpoint(input: SeamBInput): PiCompactionResult {
	const all = [...input.messagesToSummarize, ...input.turnPrefixMessages];

	// Map toolCallId -> read result, so we can attach result sizes to read calls.
	const readResults = new Map<string, ToolResultMessage>();
	for (const m of all) {
		if (isToolResult(m) && m.toolName === "read" && !m.isError) {
			readResults.set(m.toolCallId, m);
		}
	}

	const codeProductions: CodeProductionEntry[] = [];
	const reads: ReadEntry[] = [];

	for (const m of all) {
		if (!isAssistant(m)) continue;
		for (const block of m.content) {
			if (block.type !== "toolCall") continue;
			const tc = block as PiToolCall;
			const path = typeof tc.arguments?.path === "string" ? (tc.arguments.path as string) : undefined;
			if (tc.name === "write" || tc.name === "edit") {
				codeProductions.push({ tool: tc.name, path, argChars: JSON.stringify(tc.arguments).length });
			} else if (tc.name === "read") {
				const res = readResults.get(tc.id);
				const resultText = res ? toolResultText(res.content) : "";
				reads.push({
					path,
					resultChars: resultText.length,
					resultLines: resultText ? resultText.split("\n").length : 0,
				});
			}
		}
	}

	const lines: string[] = [];
	lines.push("# Deterministic compaction checkpoint");
	lines.push("");
	lines.push(
		"This checkpoint was produced deterministically (no model summarisation). It is self-contained: all file paths and sizes needed to continue are listed below. Re-run read/write/edit to recover exact content.",
	);
	if (input.previousSummary) {
		lines.push("");
		lines.push("## Prior checkpoint");
		lines.push(input.previousSummary.trim());
	}
	lines.push("");
	lines.push(`## Code productions (${codeProductions.length})`);
	if (codeProductions.length === 0) {
		lines.push("- none");
	} else {
		for (const cp of codeProductions) {
			lines.push(`- ${cp.tool} ${cp.path ?? "<unknown path>"} (~${cp.argChars} chars of arguments)`);
		}
	}
	lines.push("");
	lines.push(`## Files read (${reads.length})`);
	if (reads.length === 0) {
		lines.push("- none");
	} else {
		for (const r of reads) {
			lines.push(`- read ${r.path ?? "<unknown path>"} (${r.resultLines} lines, ${r.resultChars} chars)`);
		}
	}
	lines.push("");
	lines.push(`(${input.messagesToSummarize.length} history + ${input.turnPrefixMessages.length} turn-prefix messages summarised.)`);

	return {
		summary: lines.join("\n"),
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: input.tokensBefore,
		details: {
			kind: "deterministic-checkpoint",
			codeProductions,
			reads,
		},
	};
}

/**
 * Projection-report on/off comparison (acceptance criterion).
 *
 * Builds the same transcript the smoke test drives (write big file, read it
 * back, small edit), converts it with the adapter, and runs compaction-core's
 * `projectCompaction` in two modes on the SAME transcript:
 *   - extension OFF: compaction disabled (trigger "disabled") -> no savings.
 *   - extension ON:  threshold crossed (trigger "active")     -> real savings.
 * Then asserts the numbers are internally consistent and that ON strictly beats
 * OFF (fewer effective tokens, positive savings, sane percentage).
 *
 * Note: for pi read results (no hashline), the default hashlineExtractor used by
 * projectCompaction and the pathLineCountExtractor the extension injects yield
 * the identical outcome — path resolves from the paired read toolCall args,
 * hash is undefined — so this report faithfully reflects the extension's effect.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { projectCompaction } from "@ecode/compaction-core";
import { toCore } from "../src/adapter.js";
import { estimateAgentTokens } from "../src/projection.js";

const BIG_FILE = Array.from(
	{ length: 300 },
	(_, i) => `export const item_${i} = { id: ${i}, name: "entry-${i}", tag: "payload-${i}" };`,
).join("\n");

function usage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}
function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}
function assistant(content: AssistantMessage["content"], ts: number, stopReason: AssistantMessage["stopReason"] = "toolUse"): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "mock", usage: usage(), stopReason, timestamp: ts };
}
function toolResult(id: string, name: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1002 };
}

function buildTranscript(): AgentMessage[] {
	return [
		userMsg("create big.ts, read it, then rename item_0"),
		assistant([{ type: "text", text: "writing" }, { type: "toolCall", id: "call-write", name: "write", arguments: { path: "big.ts", content: BIG_FILE } }], 1001),
		toolResult("call-write", "write", "wrote big.ts (300 lines)"),
		assistant([{ type: "text", text: "reading" }, { type: "toolCall", id: "call-read", name: "read", arguments: { path: "big.ts" } }], 1002),
		toolResult("call-read", "read", BIG_FILE),
		assistant([{ type: "text", text: "editing" }, { type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "big.ts", oldText: "x", newText: "y" } }], 1003),
		toolResult("call-edit", "edit", "edited big.ts"),
		assistant([{ type: "text", text: "done" }], 1004, "stop"),
	];
}

describe("projection report: extension ON vs OFF (same transcript)", () => {
	it("produces internally consistent, sane numbers with ON strictly beating OFF", () => {
		const transcript = buildTranscript();
		const core = toCore(transcript);
		// One consistent estimator drives BOTH rawTokens and the projected size, so
		// the on/off comparison is apples-to-apples. Deterministic ~4 chars/token
		// over the core messages, matching compaction-core's internal estimator.
		const estimate = (msgs: typeof core.coreMessages) =>
			msgs.reduce((sum, m) => {
				let chars = (m.content ?? "").length;
				for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
				return sum + Math.ceil(chars / 4);
			}, 0);
		const rawTokens = estimate(core.coreMessages);
		// Sanity: pi's own estimator also sees a large raw context here (not asserted
		// against the char estimate; the two use different bases by design).
		expect(estimateAgentTokens(transcript)).toBeGreaterThan(0);

		const off = projectCompaction({
			messages: core.coreMessages,
			rawTokens,
			estimateTokens: estimate,
			enabled: false,
			compactAfterInputTokens: 0,
			compactionOptions: { keepRecentAssistantMessages: 1 },
		});

		const on = projectCompaction({
			messages: core.coreMessages,
			rawTokens,
			estimateTokens: estimate,
			enabled: true,
			compactAfterInputTokens: 0, // force active
			compactionOptions: { keepRecentAssistantMessages: 1 },
		});

		// OFF: disabled trigger, nothing compacted, no savings.
		expect(off.triggerState).toBe("disabled");
		expect(off.active).toBe(false);
		expect(off.compactedCount).toBe(0);
		expect(off.effectiveTokensSaved).toBe(0);
		expect(off.effectiveSavedPct).toBe(0);

		// ON: active trigger, real compaction of the write args + read result.
		expect(on.triggerState).toBe("active");
		expect(on.active).toBe(true);
		expect(on.compactedCount).toBeGreaterThanOrEqual(2); // write args + read result
		expect(on.tokensSaved).toBeGreaterThan(0);

		// ON strictly beats OFF on the same transcript.
		expect(on.compactedTokens).toBeLessThan(off.compactedTokens);
		expect(on.effectiveTokensSaved).toBeGreaterThan(0);
		expect(on.effectiveSavedPct).toBeGreaterThan(0);
		expect(on.effectiveSavedPct).toBeLessThanOrEqual(100);

		// Internal consistency: rawTokens - compactedTokens == effectiveTokensSaved.
		expect(on.rawTokens - on.compactedTokens).toBe(on.effectiveTokensSaved);

		// The per-tool breakdown names both write and read.
		const tools = on.details.map((d) => d.toolName).sort();
		expect(tools).toContain("write");
		expect(tools).toContain("read");

		// Protection window is reported and bounded by the assistant count.
		expect(on.protectedAssistantMessageCount).toBeLessThanOrEqual(on.assistantMessageCount);
		expect(on.protectedAssistantMessageCount).toBe(1); // keepRecentAssistantMessages=1
	});
});

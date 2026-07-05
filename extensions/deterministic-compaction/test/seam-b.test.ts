/**
 * Seam B tests (Task 3): the optional deterministic checkpoint.
 *
 * Verifies:
 *  - buildSeamBCheckpoint produces a self-contained summary (correction #3):
 *    every write/edit/read path + size is spelled out in the summary TEXT, so a
 *    later reader needs nothing re-derived from `details` (pi skips re-deriving
 *    file-ops from a fromHook entry on the next pass).
 *  - the checkpoint is deterministic (identical input -> identical output).
 *  - the extension registers `session_before_compact` ONLY when seam B is on.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDeterministicCompaction } from "../src/extension.js";
import { buildSeamBCheckpoint, type SeamBInput } from "../src/seam-b.js";

const BIG = Array.from({ length: 120 }, (_, i) => `line ${i}: value_${i}`).join("\n");

function usage() {
	return { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "mock", usage: usage(), stopReason: "toolUse", timestamp: 1001 };
}
function toolResult(id: string, name: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 1002 };
}

function sampleInput(): SeamBInput {
	const messagesToSummarize: AgentMessage[] = [
		userMsg("do work"),
		assistant([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/a.ts", content: BIG } }]),
		toolResult("w1", "write", "wrote src/a.ts"),
		assistant([{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/a.ts" } }]),
		toolResult("r1", "read", BIG),
		assistant([{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "src/b.ts", oldText: "x", newText: "y" } }]),
		toolResult("e1", "edit", "edited src/b.ts"),
	];
	return {
		messagesToSummarize,
		turnPrefixMessages: [],
		firstKeptEntryId: "entry-42",
		tokensBefore: 12345,
		compactionOptions: { keepRecentAssistantMessages: 3 },
	};
}

describe("buildSeamBCheckpoint", () => {
	it("returns a self-contained summary listing every code production and read with paths + sizes", () => {
		const result = buildSeamBCheckpoint(sampleInput());

		expect(result.firstKeptEntryId).toBe("entry-42");
		expect(result.tokensBefore).toBe(12345);

		const s = result.summary;
		// self-contained: paths are named in the TEXT (not only in details).
		expect(s).toContain("src/a.ts");
		expect(s).toContain("src/b.ts");
		expect(s).toContain("write src/a.ts");
		expect(s).toContain("edit src/b.ts");
		expect(s).toContain("read src/a.ts");
		// read size is spelled out (120 lines).
		expect(s).toMatch(/read src\/a\.ts \(120 lines/);
		// it announces its own determinism / self-containment.
		expect(s.toLowerCase()).toContain("self-contained");
		expect(s.toLowerCase()).toContain("deterministic");

		// details carry the structured record too (belt and suspenders), but the
		// summary text alone is sufficient.
		expect((result.details as { kind: string }).kind).toBe("deterministic-checkpoint");
	});

	it("is deterministic: identical input yields identical summary", () => {
		const a = buildSeamBCheckpoint(sampleInput());
		const b = buildSeamBCheckpoint(sampleInput());
		expect(a.summary).toBe(b.summary);
		expect(JSON.stringify(a.details)).toBe(JSON.stringify(b.details));
	});

	it("incorporates a previous checkpoint when present", () => {
		const input = sampleInput();
		input.previousSummary = "PRIOR-CHECKPOINT-MARKER";
		const result = buildSeamBCheckpoint(input);
		expect(result.summary).toContain("PRIOR-CHECKPOINT-MARKER");
	});
});

describe("extension seam-B registration gating", () => {
	function fakePi(): { pi: ExtensionAPI; events: string[] } {
		const events: string[] = [];
		const pi = {
			on(event: string) {
				events.push(event);
			},
			registerProvider() {},
		} as unknown as ExtensionAPI;
		return { pi, events };
	}

	it("does NOT register session_before_compact when seam B is disabled (default)", () => {
		const { pi, events } = fakePi();
		installDeterministicCompaction(pi, { compactAfterInputTokens: 32000, seamBEnabled: false });
		expect(events).toContain("context");
		expect(events).not.toContain("session_before_compact");
	});

	it("registers session_before_compact when seam B is enabled", () => {
		const { pi, events } = fakePi();
		installDeterministicCompaction(pi, { compactAfterInputTokens: 32000, seamBEnabled: true });
		expect(events).toContain("context");
		expect(events).toContain("session_before_compact");
	});
});

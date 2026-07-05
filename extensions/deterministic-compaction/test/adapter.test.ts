/**
 * Adapter + projection unit tests: AgentMessage <-> compaction-core Message
 * round-trip, toolCallId pairing, write/edit code-production compaction,
 * custom-message passthrough, hybrid gating, and idempotency.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { fromCore, toCore } from "../src/adapter.js";
import { projectContext } from "../src/projection.js";

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

function assistant(content: AssistantMessage["content"], ts = 1001, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: usage(),
		stopReason,
		timestamp: ts,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1002,
	};
}

// A big write payload (> minArgTokens = 800 tok ~ 3200 chars of arguments).
const BIG_FILE_CONTENT = Array.from({ length: 200 }, (_, i) => `export const symbol_${i} = ${i};`).join("\n");

describe("adapter toCore/fromCore", () => {
	it("maps user/assistant/toolResult by index and pairs toolCalls by id", () => {
		const messages: AgentMessage[] = [
			userMsg("hi"),
			assistant([
				{ type: "text", text: "calling" },
				{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.ts", content: "x" } },
			], 1001, "toolUse"),
			toolResult("c1", "write", "wrote a.ts"),
		];

		const core = toCore(messages);
		expect(core.coreMessages).toHaveLength(3);
		expect(core.coreMessages[0]).toMatchObject({ role: "user", content: "hi" });
		expect(core.coreMessages[1]).toMatchObject({ role: "assistant", content: "calling" });
		expect(core.coreMessages[1].toolCalls).toHaveLength(1);
		expect(core.coreMessages[1].toolCalls![0]).toMatchObject({ id: "c1", name: "write" });
		expect(core.coreMessages[2]).toMatchObject({ role: "tool", toolCallId: "c1", toolName: "write" });
		expect((core.coreMessages[2].meta as { isError: boolean }).isError).toBe(false);
	});

	it("preserves toolResult isError into meta", () => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "z" } }], 1001, "toolUse"),
			toolResult("c1", "read", "boom", true),
		];
		const core = toCore(messages);
		expect((core.coreMessages[1].meta as { isError: boolean }).isError).toBe(true);
	});

	it("passes custom (non-LLM) messages through unchanged at their index", () => {
		const custom = { role: "compactionSummary", content: "sum", timestamp: 1234 } as unknown as AgentMessage;
		const messages: AgentMessage[] = [custom, userMsg("after summary")];
		const core = toCore(messages);
		// Only the user message is an LLM message; the custom one is passthrough.
		expect(core.coreMessages).toHaveLength(1);
		expect(core.passthrough.get(0)).toBe(custom);

		const back = fromCore(messages, core, core.coreMessages);
		expect(back[0]).toBe(custom);
		expect(back).toHaveLength(2);
	});
});

describe("projectContext code-production (write/edit) compaction", () => {
	it("compacts a large write toolCall argument and writes the summary back into the assistant block", () => {
		const messages: AgentMessage[] = [
			userMsg("write the file"),
			assistant([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "big.ts", content: BIG_FILE_CONTENT } }], 1001, "toolUse"),
			toolResult("w1", "write", "ok"),
			assistant([{ type: "text", text: "a" }], 2000),
			assistant([{ type: "text", text: "b" }], 2001),
			assistant([{ type: "text", text: "c" }], 2002),
			assistant([{ type: "text", text: "d" }], 2003),
		];

		const outcome = projectContext(messages, {
			compactAfterInputTokens: 0,
			compactionOptions: { keepRecentAssistantMessages: 3 },
		});

		expect(outcome.projected).toBe(true);
		expect(outcome.compaction?.compactedCount).toBe(1);

		const projectedAssistant = outcome.messages[1] as AssistantMessage;
		const block = projectedAssistant.content.find((b) => b.type === "toolCall")!;
		expect(block.type).toBe("toolCall");
		if (block.type === "toolCall") {
			expect(block.id).toBe("w1");
			// arguments replaced by a CodeProductionSummary object
			expect(block.arguments).toHaveProperty("compacted", "code-production");
			expect(block.arguments).toHaveProperty("path", "big.ts");
		}
	});

	it("does not touch the raw content of untouched (small) messages", () => {
		const messages: AgentMessage[] = [
			userMsg("small"),
			assistant([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "s.ts", content: "tiny" } }], 1001, "toolUse"),
			toolResult("w1", "write", "ok"),
		];
		const outcome = projectContext(messages, { compactAfterInputTokens: 0, compactionOptions: { keepRecentAssistantMessages: 3 } });
		// small args -> nothing to compact -> identity
		expect(outcome.projected).toBe(false);
		expect(outcome.messages).toBe(messages);
	});
});

describe("hybrid gating (prefix-cache preservation)", () => {
	it("returns the SAME array reference (identity) below the token threshold", () => {
		const messages: AgentMessage[] = [
			userMsg("write the file"),
			assistant([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "big.ts", content: BIG_FILE_CONTENT } }], 1001, "toolUse"),
			toolResult("w1", "write", "ok"),
		];
		const outcome = projectContext(messages, { compactAfterInputTokens: 10_000_000 });
		expect(outcome.projected).toBe(false);
		expect(outcome.messages).toBe(messages); // identity, byte-stable prefix
	});
});

describe("idempotency", () => {
	it("projecting twice yields an equivalent result (second pass is a no-op on already-compacted content)", () => {
		const messages: AgentMessage[] = [
			userMsg("write the file"),
			assistant([{ type: "toolCall", id: "w1", name: "write", arguments: { path: "big.ts", content: BIG_FILE_CONTENT } }], 1001, "toolUse"),
			toolResult("w1", "write", "ok"),
			assistant([{ type: "text", text: "a" }], 2000),
			assistant([{ type: "text", text: "b" }], 2001),
			assistant([{ type: "text", text: "c" }], 2002),
			assistant([{ type: "text", text: "d" }], 2003),
		];
		const cfg = { compactAfterInputTokens: 0, compactionOptions: { keepRecentAssistantMessages: 3 } };
		const first = projectContext(messages, cfg);
		expect(first.projected).toBe(true);

		// Feed the projected messages back through: already-compacted args are now
		// small, so the second pass compacts nothing -> identity.
		const second = projectContext(first.messages, cfg);
		expect(second.projected).toBe(false);
		expect(second.messages).toBe(first.messages);
	});
});

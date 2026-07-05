/**
 * Dedicated test for correction #1 (the single most load-bearing correction):
 *
 * pi's `read` tool result is PLAIN FILE TEXT — no `¶path#hash` header, no path
 * prefix, no content hash of any kind (docs/g0-survey.md Item 1). So path/hash
 * extraction for read results MUST NOT read a hashline out of the result body.
 * Instead:
 *   - `path` is resolved from the paired read toolCall's `{path}` argument
 *     (pair by toolCallId), and
 *   - `hash` degrades to undefined (compaction-core's pathLineCountExtractor
 *     never emits one; line/char counts are computed from the body).
 *
 * This test drives the real adapter + projection against a plain-text read
 * result and asserts the degraded path works: the read is compacted, the path
 * comes from arguments, and no hash appears.
 */

import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { compactCodeProductions } from "@ecode/compaction-core";
import { toCore } from "../src/adapter.js";
import { PI_COMPACTION_INJECTION, projectContext } from "../src/projection.js";

// A large, plain-text read body with NO hashline / NO path prefix — exactly what
// pi's read tool returns. Deliberately > minResultTokens (200 tok ~= 800 chars).
const PLAIN_READ_BODY = Array.from(
	{ length: 120 },
	(_, i) => `line ${i + 1}: const value_${i} = computeSomething(${i}, "payload-${i}");`,
).join("\n");

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}

function assistantReadCall(toolCallId: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Reading the file." },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1001,
	};
}

function readResult(toolCallId: string, body: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: body }],
		isError: false,
		timestamp: 1002,
	};
}

/** A few trailing assistant turns so the read is NOT inside the protected window. */
function trailingAssistant(text: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 5,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: ts,
	};
}

describe("read-result path/hash degradation (correction #1)", () => {
	it("the read body genuinely has no hashline / no path prefix / no hash", () => {
		const firstLine = PLAIN_READ_BODY.split("\n", 1)[0]!;
		expect(firstLine).not.toMatch(/^¶/);
		expect(firstLine).not.toMatch(/#[0-9a-f]{8}/);
		expect(firstLine).not.toMatch(/^path:/i);
		expect(PLAIN_READ_BODY).not.toContain("¶");
	});

	it("compacts the read result and resolves path from the paired toolCall arguments, hash undefined", () => {
		const messages: AgentMessage[] = [
			userMsg("read src/big.ts please"),
			assistantReadCall("call-1", "src/big.ts"),
			readResult("call-1", PLAIN_READ_BODY),
			// push the read out of the keepRecent=3 assistant window
			trailingAssistant("done reading, thinking", 2000),
			trailingAssistant("still working", 2001),
			trailingAssistant("more work", 2002),
			trailingAssistant("final", 2003),
		];

		const core = toCore(messages);
		const result = compactCodeProductions(
			core.coreMessages,
			{ keepRecentAssistantMessages: 3 },
			PI_COMPACTION_INJECTION,
		);

		// The read result was compacted...
		expect(result.compactedCount).toBe(1);
		const readDetail = result.details.find((d) => d.toolName === "read");
		expect(readDetail?.compactedCount).toBe(1);

		// ...the diff carries the path resolved FROM ARGUMENTS (not from a hashline).
		const diff = result.diffs.find((d) => d.toolName === "read");
		expect(diff).toBeDefined();
		expect(diff!.path).toBe("src/big.ts");

		// ...the compacted tool-result message stamped meta.compacted with the
		// ReadResultSummary: path from args, hash undefined (degraded path).
		const compactedCore = result.messages.find((m) => m.role === "tool" && m.toolCallId === "call-1")!;
		const summary = (compactedCore.meta as Record<string, unknown>).compacted as {
			compacted: string;
			tool: string;
			path?: string;
			hash?: string;
			chars: number;
			lines: number;
		};
		expect(summary.compacted).toBe("read-result");
		expect(summary.tool).toBe("read");
		expect(summary.path).toBe("src/big.ts");
		expect(summary.hash).toBeUndefined();
		expect(summary.lines).toBe(120);
		expect(summary.chars).toBe(PLAIN_READ_BODY.length);

		// And the summary text carries NO hash marker (would be ", #<hash>").
		expect(compactedCore.content).toContain("[compacted read result]");
		expect(compactedCore.content).not.toMatch(/#[0-9a-f]{8}/);
	});

	it("path degrades to undefined when the read toolCall arguments lack a path (and still no hash)", () => {
		// Simulate a read call whose arguments somehow omit path — extraction must
		// not invent one, and must not fabricate a hash from the plain body.
		const messages: AgentMessage[] = [
			userMsg("read something"),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-x", name: "read", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "mock",
				usage: {
					input: 5,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 1001,
			} satisfies AssistantMessage,
			readResult("call-x", PLAIN_READ_BODY),
			trailingAssistant("a", 2000),
			trailingAssistant("b", 2001),
			trailingAssistant("c", 2002),
			trailingAssistant("d", 2003),
		];

		const core = toCore(messages);
		const result = compactCodeProductions(
			core.coreMessages,
			{ keepRecentAssistantMessages: 3 },
			PI_COMPACTION_INJECTION,
		);

		expect(result.compactedCount).toBe(1);
		const compactedCore = result.messages.find((m) => m.role === "tool" && m.toolCallId === "call-x")!;
		const summary = (compactedCore.meta as Record<string, unknown>).compacted as {
			path?: string;
			hash?: string;
		};
		expect(summary.path).toBeUndefined();
		expect(summary.hash).toBeUndefined();
	});

	it("projectContext maps the compacted read back into a pi toolResult (send payload) with the summary text", () => {
		const messages: AgentMessage[] = [
			userMsg("read src/big.ts please"),
			assistantReadCall("call-1", "src/big.ts"),
			readResult("call-1", PLAIN_READ_BODY),
			trailingAssistant("done", 2000),
			trailingAssistant("more", 2001),
			trailingAssistant("even more", 2002),
			trailingAssistant("final", 2003),
		];

		// Threshold 0 forces projection regardless of size.
		const outcome = projectContext(messages, {
			compactAfterInputTokens: 0,
			compactionOptions: { keepRecentAssistantMessages: 3 },
		});

		expect(outcome.projected).toBe(true);
		const sent = outcome.messages.find(
			(m): m is ToolResultMessage => m.role === "toolResult" && (m as ToolResultMessage).toolCallId === "call-1",
		)!;
		const text = sent.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		expect(text).toContain("[compacted read result]");
		expect(text).toContain("src/big.ts");
		expect(text).not.toMatch(/#[0-9a-f]{8}/);
		// pairing survives: the toolCallId is unchanged on the projected result.
		expect(sent.toolCallId).toBe("call-1");
	});
});

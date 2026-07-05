import { describe, it, expect } from "vitest";
import { staleViewHints, staleHintMessage } from "../src/trust-hint.ts";
import { TrustLedger, hashContent } from "../src/trust-ledger.ts";
import type { Message } from "../src/compaction-core.js";

function readCall(toolCallId: string, path: string): Message {
	return {
		id: `a-${toolCallId}`,
		role: "assistant",
		content: "",
		toolCalls: [{ id: toolCallId, name: "read", arguments: { path } }],
		createdAt: "0",
	};
}
function readResult(toolCallId: string, content: string): Message {
	return { id: `tr-${toolCallId}`, role: "tool", toolCallId, toolName: "read", content, createdAt: "0" };
}

describe("staleViewHints — T3 (read views only, ledger mismatch)", () => {
	it("no hint when the read view hash matches the ledger", () => {
		const ledger = new TrustLedger();
		ledger.recordEdit("/a.ts", "current", 5, "+1 -0");
		const messages = [readCall("tc1", "/a.ts"), readResult("tc1", "current")];
		expect(staleViewHints(messages, ledger)).toEqual([]);
	});

	it("emits an exact-format hint when the read view predates an edit", () => {
		const ledger = new TrustLedger();
		ledger.recordEdit("/a.ts", "new content", 7, "+3 -1");
		const messages = [readCall("tc1", "/a.ts"), readResult("tc1", "old content")];
		expect(staleViewHints(messages, ledger)).toEqual([
			`[stale-view] /a.ts: view from ${hashContent("old content")} predates your edit at turn 7 (now ${hashContent("new content")}); re-read only if you need current content.`,
		]);
	});

	it("does NOT hint on bash results (ruling: bash excluded)", () => {
		const ledger = new TrustLedger();
		ledger.recordEdit("/a.ts", "new", 7, "+1 -0");
		const bashCall: Message = {
			id: "a1",
			role: "assistant",
			content: "",
			toolCalls: [{ id: "tc1", name: "bash", arguments: { command: "cat /a.ts" } }],
			createdAt: "0",
		};
		const bashResult: Message = { id: "tr1", role: "tool", toolCallId: "tc1", toolName: "bash", content: "stale bytes", createdAt: "0" };
		expect(staleViewHints([bashCall, bashResult], ledger)).toEqual([]);
	});

	it("does not hint when the path was only read, never edited (no diffstat)", () => {
		const ledger = new TrustLedger();
		ledger.recordView("/a.ts", "whatever", 3);
		const messages = [readCall("tc1", "/a.ts"), readResult("tc1", "old")];
		expect(staleViewHints(messages, ledger)).toEqual([]);
	});

	it("at most one hint per path", () => {
		const ledger = new TrustLedger();
		ledger.recordEdit("/a.ts", "new", 7, "+1 -0");
		const messages = [
			readCall("tc1", "/a.ts"),
			readResult("tc1", "old1"),
			readCall("tc2", "/a.ts"),
			readResult("tc2", "old2"),
		];
		expect(staleViewHints(messages, ledger).length).toBe(1);
	});
});

describe("staleHintMessage — T3 volatile tail (prefix stability)", () => {
	it("is appended, leaving the base array as an unchanged prefix", () => {
		const base = [
			{ role: "user", content: "hi", timestamp: 1 },
			{ role: "assistant", content: "ok", timestamp: 2 },
		];
		const hints = ["[stale-view] /a.ts: view from aaaa1111 predates your edit at turn 4 (now bbbb2222); re-read only if you need current content."];
		const sent = [...base, staleHintMessage(hints)];
		// The cache-critical property: every original message is byte-identical and in place.
		expect(sent.slice(0, base.length)).toEqual(base);
		expect(sent).toHaveLength(base.length + 1);
		expect(sent[sent.length - 1]).toEqual({ role: "user", content: hints[0], timestamp: 0 });
	});

	it("joins multiple hints into one tail block", () => {
		const msg = staleHintMessage(["a", "b"]);
		expect(msg).toEqual({ role: "user", content: "a\nb", timestamp: 0 });
	});
});

/**
 * V2-TP mock replay fixture — acceptance scenario:
 * "edit 后读到旧视图" → flag-on 时模型输入里出现 stale-view 行。
 *
 * Full sequence:
 *   1. Model reads src/app.ts → sees content "v1"
 *   2. Model edits src/app.ts → file on disk becomes "v2"
 *   3. Context hook fires with the OLD read result (content "v1") still in messages
 *   4. Assert: the outgoing messages array has a trailing stale-view hint
 *
 * This fixture tests the complete wiring path:
 *   tool_result(read) → ledger.recordView
 *   tool_result(edit) → ledger.recordEdit (reads disk)
 *   context hook → staleViewHints → volatile tail append
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDeterministicCompaction, type DeterministicCompactionConfig } from "../src/extension.ts";
import { hashContent } from "../src/trust-ledger.ts";

type Handler = (...args: any[]) => any;
interface MockPi {
	handlers: Map<string, Handler[]>;
	on(event: string, handler: Handler): void;
	fire(event: string, ...args: any[]): any;
}

function createMockPi(): MockPi {
	const handlers = new Map<string, Handler[]>();
	return {
		handlers,
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		fire(event: string, ...args: any[]) {
			const list = handlers.get(event) ?? [];
			let result: any;
			for (const h of list) result = h(...args);
			return result;
		},
	};
}

function mockCtx(cwd: string) {
	return { sessionManager: { getCwd: () => cwd, getSessionId: () => "fixture-session" }, ui: {} };
}

describe("V2-TP fixture replay: edit → stale read → hint appears (flag-on)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "src"), { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stale-view hint fires when model input contains a read predating an edit", () => {
		const config: DeterministicCompactionConfig = {
			compactAfterInputTokens: 999999,
			seamBEnabled: false,
			trustProtocolEnabled: true,
		};
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, config, { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		// --- Turn 1: model reads src/app.ts ---
		pi.fire("context", { messages: [] }, ctx); // turn counter → 1

		pi.fire("tool_result", {
			type: "tool_result",
			toolCallId: "read-1",
			toolName: "read",
			input: { path: "src/app.ts" },
			content: [{ type: "text", text: "export const version = 1;\n" }],
			isError: false,
			details: undefined,
		}, ctx);

		// --- Turn 2: model edits src/app.ts (file on disk becomes v2) ---
		pi.fire("context", { messages: [] }, ctx); // turn counter → 2

		writeFileSync(join(tempDir, "src/app.ts"), "export const version = 2;\n");
		const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const version = 1;\n+export const version = 2;\n";
		pi.fire("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "edit",
			input: { path: "src/app.ts", edits: [{ old_string: "version = 1", new_string: "version = 2" }] },
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app.ts." }],
			isError: false,
			details: { diff: "...", patch, firstChangedLine: 1 },
		}, ctx);

		// --- Turn 3: context hook fires with the OLD read (v1) still in messages ---
		pi.fire("context", { messages: [] }, ctx); // turn counter → 3

		const messagesWithStaleRead = [
			// The assistant issued a read on turn 1
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } }], timestamp: 100 },
			// The read result returned v1 content
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const version = 1;\n" }], isError: false, timestamp: 101 },
			// The assistant then edited the file
			{ role: "assistant", content: [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "src/app.ts", edits: [] } }], timestamp: 200 },
			// The edit result
			{ role: "toolResult", toolCallId: "edit-1", toolName: "edit", content: [{ type: "text", text: "OK" }], isError: false, timestamp: 201 },
			// Now a new user message triggers a fresh context hook
			{ role: "user", content: "What did you change?", timestamp: 300 },
		];

		// Fire the context hook with these messages — should produce a stale-view hint
		const result = pi.fire("context", { messages: messagesWithStaleRead }, ctx);

		// ASSERTION: the hook returns messages with a trailing stale-view hint
		expect(result).toBeDefined();
		expect(result.messages).toBeDefined();
		const hintMsg = result.messages[result.messages.length - 1];
		expect(hintMsg.role).toBe("user");
		expect(hintMsg.content).toContain("[stale-view]");
		expect(hintMsg.content).toContain("src/app.ts");
		expect(hintMsg.content).toContain("predates your edit at turn 2");
		expect(hintMsg.content).toContain(hashContent("export const version = 2;\n"));
		expect(hintMsg.content).toContain(hashContent("export const version = 1;\n"));

		// The original messages are preserved as a prefix (cache stability)
		expect(result.messages.slice(0, messagesWithStaleRead.length)).toEqual(messagesWithStaleRead);
	});

	it("NO hint when flag is OFF (v1 byte-identical behavior)", () => {
		const config: DeterministicCompactionConfig = {
			compactAfterInputTokens: 999999,
			seamBEnabled: false,
			trustProtocolEnabled: false,
		};
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, config, { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);

		// Even if we fire tool_result events, nothing should happen (no handler registered)
		// The context hook should return undefined (pass-through)
		const messagesWithStaleRead = [
			{ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/app.ts" } }], timestamp: 100 },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "old" }], isError: false, timestamp: 101 },
			{ role: "user", content: "hi", timestamp: 300 },
		];

		const result = pi.fire("context", { messages: messagesWithStaleRead }, ctx);

		// flag-off: MUST return undefined (identity — no modification to messages)
		expect(result).toBeUndefined();
	});

	it("no hint when the read view is current (hash matches post-edit)", () => {
		const config: DeterministicCompactionConfig = {
			compactAfterInputTokens: 999999,
			seamBEnabled: false,
			trustProtocolEnabled: true,
		};
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, config, { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		writeFileSync(join(tempDir, "src/fresh.ts"), "current content\n");

		// Model reads the file AFTER the edit (content matches disk)
		pi.fire("tool_result", {
			type: "tool_result",
			toolCallId: "edit-1",
			toolName: "write",
			input: { path: "src/fresh.ts", content: "current content\n" },
			content: [{ type: "text", text: "OK" }],
			isError: false,
			details: undefined,
		}, ctx);

		// A read that returns the SAME content as what was written → no hint
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/fresh.ts" } }], timestamp: 100 },
			{ role: "toolResult", toolCallId: "r1", toolName: "read", content: [{ type: "text", text: "current content\n" }], isError: false, timestamp: 101 },
		];

		const result = pi.fire("context", { messages }, ctx);
		expect(result).toBeUndefined();
	});
});

/**
 * V2-TP task 1+2 wiring test — tool_result events populate the ledger, which
 * feeds stale-view hints in the context hook.
 *
 * Uses a lightweight mock pi that captures event handlers and lets us fire them
 * manually, avoiding the full createAgentSession weight. The test exercises:
 *   - read → ledger.recordView
 *   - edit → ledger.recordEdit (post-write hash from disk, diffstat from patch)
 *   - write → ledger.recordEdit (content from args, line-count diffstat)
 *   - flag-off: none of the above fires (baseline discipline)
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
	return { sessionManager: { getCwd: () => cwd, getSessionId: () => "test-session" }, ui: {} };
}

function flagOnConfig(): DeterministicCompactionConfig {
	return {
		compactAfterInputTokens: 999999,
		seamBEnabled: false,
		trustProtocolEnabled: true,
	};
}

function flagOffConfig(): DeterministicCompactionConfig {
	return {
		compactAfterInputTokens: 999999,
		seamBEnabled: false,
		trustProtocolEnabled: false,
	};
}

describe("V2-TP wiring: tool_result → ledger (flag-on)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-wiring-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});
	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("read tool_result records a view in the ledger", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOnConfig(), { observability: false, telemetry: { disabled: true } });

		// Simulate one context event to advance turn counter
		pi.fire("context", { messages: [] }, mockCtx(tempDir));

		// Fire a read tool_result
		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "read",
				input: { path: "src/foo.ts" },
				content: [{ type: "text", text: "const x = 1;\n" }],
				isError: false,
				details: undefined,
			},
			mockCtx(tempDir),
		);

		// Now fire a write to the same path → ledger gets diffstat (hint only fires on edited paths)
		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc2",
				toolName: "write",
				input: { path: "src/foo.ts", content: "const x = 2;\n" },
				content: [{ type: "text", text: "Successfully wrote 14 bytes to src/foo.ts" }],
				isError: false,
				details: undefined,
			},
			mockCtx(tempDir),
		);

		// Now the context hook should produce a stale hint for the old read
		const result = pi.fire("context", { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "src/foo.ts" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "const x = 1;\n" }], isError: false, timestamp: 0 },
		] }, mockCtx(tempDir));

		// The hook should return messages with a stale-view hint appended
		expect(result?.messages).toBeDefined();
		const last = result.messages[result.messages.length - 1];
		expect(last.content).toContain("[stale-view]");
		expect(last.content).toContain("src/foo.ts");
	});

	it("edit tool_result records post-write hash from disk", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOnConfig(), { observability: false, telemetry: { disabled: true } });
		pi.fire("context", { messages: [] }, mockCtx(tempDir));

		// Write the file to disk first (simulating what the edit tool does)
		const filePath = join(tempDir, "src/bar.ts");
		mkdirSync(join(tempDir, "src"), { recursive: true });
		writeFileSync(filePath, "const y = 42;\n");

		const patch = "--- a/src/bar.ts\n+++ b/src/bar.ts\n@@ -1 +1 @@\n-const y = 1;\n+const y = 42;\n";
		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "edit",
				input: { path: "src/bar.ts", edits: [{ old_string: "const y = 1;", new_string: "const y = 42;" }] },
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/bar.ts." }],
				isError: false,
				details: { diff: "...", patch, firstChangedLine: 1 },
			},
			mockCtx(tempDir),
		);

		// The hint scanner should see: old read hash ≠ ledger hash (from edit)
		const result = pi.fire("context", { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "tc0", name: "read", arguments: { path: "src/bar.ts" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "tc0", toolName: "read", content: [{ type: "text", text: "const y = 1;\n" }], isError: false, timestamp: 0 },
		] }, mockCtx(tempDir));

		expect(result?.messages).toBeDefined();
		const last = result.messages[result.messages.length - 1];
		expect(last.content).toContain("[stale-view]");
		expect(last.content).toContain(hashContent("const y = 42;\n"));
	});

	it("edit diffstat is parsed from the unified patch", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOnConfig(), { observability: false, telemetry: { disabled: true } });
		pi.fire("context", { messages: [] }, mockCtx(tempDir));

		mkdirSync(join(tempDir, "src"), { recursive: true });
		writeFileSync(join(tempDir, "src/c.ts"), "line1\nline2\nline3\n");

		const patch = "--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1,2 +1,3 @@\n line1\n+inserted\n line2\n";
		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "edit",
				input: { path: "src/c.ts" },
				content: [{ type: "text", text: "OK" }],
				isError: false,
				details: { diff: "", patch, firstChangedLine: 2 },
			},
			mockCtx(tempDir),
		);

		// Verify the hint message includes "predates your edit" (proving diffstat was set)
		const result = pi.fire("context", { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "tc0", name: "read", arguments: { path: "src/c.ts" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "tc0", toolName: "read", content: [{ type: "text", text: "old content" }], isError: false, timestamp: 0 },
		] }, mockCtx(tempDir));

		expect(result?.messages).toBeDefined();
		const last = result.messages[result.messages.length - 1];
		expect(last.content).toContain("predates your edit at turn 1");
	});

	it("write tool_result uses line-count diffstat", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOnConfig(), { observability: false, telemetry: { disabled: true } });
		pi.fire("context", { messages: [] }, mockCtx(tempDir));

		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "write",
				input: { path: "out.txt", content: "a\nb\nc\n" },
				content: [{ type: "text", text: "Successfully wrote 6 bytes" }],
				isError: false,
				details: undefined,
			},
			mockCtx(tempDir),
		);

		// The write result hash = hash("a\nb\nc\n"), 4 lines (3 + trailing empty after split)
		const result = pi.fire("context", { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "tc0", name: "read", arguments: { path: "out.txt" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "tc0", toolName: "read", content: [{ type: "text", text: "old" }], isError: false, timestamp: 0 },
		] }, mockCtx(tempDir));

		expect(result?.messages).toBeDefined();
		const last = result.messages[result.messages.length - 1];
		expect(last.content).toContain("[stale-view]");
		expect(last.content).toContain(hashContent("a\nb\nc\n"));
	});

	it("error tool_result is ignored", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOnConfig(), { observability: false, telemetry: { disabled: true } });
		pi.fire("context", { messages: [] }, mockCtx(tempDir));

		pi.fire(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc1",
				toolName: "read",
				input: { path: "missing.ts" },
				content: [{ type: "text", text: "ENOENT: no such file" }],
				isError: true,
				details: undefined,
			},
			mockCtx(tempDir),
		);

		// No ledger entry → no hint
		const result = pi.fire("context", { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "missing.ts" } }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "tc1", toolName: "read", content: [{ type: "text", text: "ENOENT: no such file" }], isError: false, timestamp: 0 },
		] }, mockCtx(tempDir));

		// Should return undefined (pass-through, no hint) because no diffstat in ledger
		expect(result).toBeUndefined();
	});
});

describe("V2-TP wiring: flag-off baseline (no tool_result handler registered)", () => {
	it("does NOT register a tool_result handler when flag is off", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, flagOffConfig(), { observability: false, telemetry: { disabled: true } });
		expect(pi.handlers.get("tool_result")).toBeUndefined();
	});
});

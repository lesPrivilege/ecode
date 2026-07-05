/**
 * V3-WS task 2+3 — event wiring + projected-turn tail injection.
 *
 * Reuses V2-TP's tool_result listener (widened to fire under EITHER flag) and its
 * hash/diffstat computation to feed the WorkAnchor. The anchor block is injected
 * into the volatile send-time tail ONLY on a projected turn (a non-projected turn
 * still carries full recent context, so it needs no anchor), at most one per turn,
 * replacement-not-append.
 *
 * Discipline checks pinned here: flag two-state (ECODE_SEMANTIC_ANCHOR off ⇒
 * byte-identical to v1), tail position (projected-only, trailing), replacement
 * (≤1 block/turn, no leftover prefix).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
	installDeterministicCompaction,
	resolveConfig,
	type DeterministicCompactionConfig,
} from "../src/extension.ts";

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
	return { sessionManager: { getCwd: () => cwd, getSessionId: () => "anchor-session" }, ui: {} };
}

/** anchor-on (trust off) unless overridden. compactAfterInputTokens 0 ⇒ any compactable turn projects. */
function anchorConfig(over: Partial<DeterministicCompactionConfig> = {}): DeterministicCompactionConfig {
	return {
		compactAfterInputTokens: 0,
		compactionOptions: { keepRecentAssistantMessages: 3 },
		seamBEnabled: false,
		trustProtocolEnabled: false,
		semanticAnchorEnabled: true,
		...over,
	};
}

// --- projecting-message fixture (mirrors read-degradation.test.ts) -------------
const BIG_READ = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: const v_${i} = f(${i});`).join("\n");

function userMsg(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 1000 };
}
function readCall(id: string, path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: 1001,
	};
}
function readResult(id: string, body: string): ToolResultMessage {
	return { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: body }], isError: false, timestamp: 1002 };
}
function tail(text: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: ts,
	};
}
/** A message array that WILL project (big read pushed out of the keepRecent window). */
function projectingMessages(): AgentMessage[] {
	return [
		userMsg("read src/big.ts"),
		readCall("big-1", "src/big.ts"),
		readResult("big-1", BIG_READ),
		tail("a", 2000),
		tail("b", 2001),
		tail("c", 2002),
		tail("d", 2003),
	];
}

function toolResult(over: Record<string, unknown>) {
	return { type: "tool_result", isError: false, details: undefined, ...over };
}

function lastMsg(result: any): any {
	return result.messages[result.messages.length - 1];
}

describe("resolveConfig — ECODE_SEMANTIC_ANCHOR / ECODE_ANCHOR_ACCEPTANCE", () => {
	let savedFlag: string | undefined;
	let savedAccept: string | undefined;
	beforeEach(() => {
		savedFlag = process.env.ECODE_SEMANTIC_ANCHOR;
		savedAccept = process.env.ECODE_ANCHOR_ACCEPTANCE;
	});
	afterEach(() => {
		if (savedFlag === undefined) delete process.env.ECODE_SEMANTIC_ANCHOR;
		else process.env.ECODE_SEMANTIC_ANCHOR = savedFlag;
		if (savedAccept === undefined) delete process.env.ECODE_ANCHOR_ACCEPTANCE;
		else process.env.ECODE_ANCHOR_ACCEPTANCE = savedAccept;
	});

	it("defaults OFF when the env var is unset", () => {
		delete process.env.ECODE_SEMANTIC_ANCHOR;
		expect(resolveConfig().semanticAnchorEnabled).toBe(false);
	});

	it("is ON when ECODE_SEMANTIC_ANCHOR=1", () => {
		process.env.ECODE_SEMANTIC_ANCHOR = "1";
		expect(resolveConfig().semanticAnchorEnabled).toBe(true);
	});

	it("parses ECODE_ANCHOR_ACCEPTANCE into a trimmed, non-empty target list", () => {
		process.env.ECODE_ANCHOR_ACCEPTANCE = "SUBSYSTEM-MAP.md, docs/out.md ,,";
		expect(resolveConfig().anchorAcceptanceTargets).toEqual(["SUBSYSTEM-MAP.md", "docs/out.md"]);
	});

	it("leaves targets undefined when ECODE_ANCHOR_ACCEPTANCE is unset", () => {
		delete process.env.ECODE_ANCHOR_ACCEPTANCE;
		expect(resolveConfig().anchorAcceptanceTargets).toBeUndefined();
	});
});

describe("wiring — tool_result handler registration (flag two-state)", () => {
	it("registers a tool_result handler when only the anchor flag is on", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		expect(pi.handlers.get("tool_result")).toBeDefined();
	});
});

describe("wiring — anchor injected on a PROJECTED turn (anchor on)", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `anchor-wire-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "src"), { recursive: true });
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("appends a [work-anchor] tail carrying an edit recorded from tool_result", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx); // turn → 1 (not projected: no compactable content)

		writeFileSync(join(tempDir, "src/edited.ts"), "export const x = 2;\n");
		const patch = "--- a/src/edited.ts\n+++ b/src/edited.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n";
		pi.fire("tool_result", toolResult({ toolName: "edit", input: { path: "src/edited.ts" }, content: [{ type: "text", text: "OK" }], details: { patch } }), ctx);

		const result = pi.fire("context", { messages: projectingMessages() }, ctx); // turn → 2, projects

		expect(result?.messages).toBeDefined();
		const anchor = lastMsg(result);
		expect(anchor.role).toBe("user");
		expect(anchor.content).toContain("[work-anchor] turn 2");
		expect(anchor.content).toContain("edits: src/edited.ts +1 -1 hash");
	});

	it("records a bash test run and surfaces it in the anchor block", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		pi.fire("tool_result", toolResult({ toolName: "bash", input: { command: "npm test" }, content: [{ type: "text", text: "Tests  7 passed (7)" }] }), ctx);

		const result = pi.fire("context", { messages: projectingMessages() }, ctx);
		expect(lastMsg(result).content).toContain("tests: npm test → 7/7 pass");
	});

	it("records a FAILED edit honestly (isError tool_result)", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		pi.fire("tool_result", toolResult({ toolName: "edit", isError: true, input: { path: "src/broke.ts" }, content: [{ type: "text", text: "no match" }] }), ctx);

		const result = pi.fire("context", { messages: projectingMessages() }, ctx);
		expect(lastMsg(result).content).toContain("edits: src/broke.ts failed");
	});

	it("includes a pending target that was never produced", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig({ anchorAcceptanceTargets: ["SUBSYSTEM-MAP.md"] }), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		const result = pi.fire("context", { messages: projectingMessages() }, ctx);
		expect(lastMsg(result).content).toContain("pending: SUBSYSTEM-MAP.md");
	});
});

describe("wiring — tail position discipline", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `anchor-pos-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "src"), { recursive: true });
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("does NOT inject on a non-projected turn even with anchor state present", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		writeFileSync(join(tempDir, "src/e.ts"), "y\n");
		pi.fire("tool_result", toolResult({ toolName: "edit", input: { path: "src/e.ts" }, content: [{ type: "text", text: "OK" }], details: { patch: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" } }), ctx);

		// A tiny, non-compactable message array ⇒ not projected ⇒ identity (undefined).
		const result = pi.fire("context", { messages: [userMsg("hi")] }, ctx);
		expect(result).toBeUndefined();
	});

	it("injects at most ONE anchor block per turn, with no leftover from the prior turn (replacement)", () => {
		const pi = createMockPi();
		installDeterministicCompaction(pi as any, anchorConfig(), { observability: false, telemetry: { disabled: true } });
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		writeFileSync(join(tempDir, "src/e.ts"), "y\n");
		pi.fire("tool_result", toolResult({ toolName: "edit", input: { path: "src/e.ts" }, content: [{ type: "text", text: "OK" }], details: { patch: "--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n" } }), ctx);

		const first = pi.fire("context", { messages: projectingMessages() }, ctx);
		const second = pi.fire("context", { messages: projectingMessages() }, ctx);

		const countAnchors = (r: any) => r.messages.filter((m: any) => typeof m.content === "string" && m.content.includes("[work-anchor]")).length;
		expect(countAnchors(first)).toBe(1);
		expect(countAnchors(second)).toBe(1);
		// The projected prefix (everything but the trailing anchor) carries no anchor block.
		const prefix = second.messages.slice(0, second.messages.length - 1);
		expect(prefix.some((m: any) => typeof m.content === "string" && m.content.includes("[work-anchor]"))).toBe(false);
	});
});

describe("wiring — flag-off byte-equivalence (projected turn)", () => {
	let tempDir: string;
	beforeEach(() => {
		tempDir = join(tmpdir(), `anchor-off-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempDir, "src"), { recursive: true });
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("anchor OFF ⇒ a projected turn carries NO anchor tail (identical to pre-V3-WS)", () => {
		const pi = createMockPi();
		installDeterministicCompaction(
			pi as any,
			anchorConfig({ semanticAnchorEnabled: false }),
			{ observability: false, telemetry: { disabled: true } },
		);
		const ctx = mockCtx(tempDir);

		pi.fire("context", { messages: [] }, ctx);
		// Even if a tool_result fires, no handler should record for the anchor (flag off, trust off).
		writeFileSync(join(tempDir, "src/e.ts"), "y\n");
		pi.fire("tool_result", toolResult({ toolName: "edit", input: { path: "src/e.ts" }, content: [{ type: "text", text: "OK" }] }), ctx);

		const result = pi.fire("context", { messages: projectingMessages() }, ctx);
		// Projected, so a { messages } is returned — but NOTHING that looks like an anchor block.
		expect(result?.messages).toBeDefined();
		expect(result.messages.some((m: any) => typeof m.content === "string" && m.content.includes("[work-anchor]"))).toBe(false);
	});
});

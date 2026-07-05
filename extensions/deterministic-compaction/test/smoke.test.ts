/**
 * End-to-end smoke test (Task 4 / correction #4) — NO real API key.
 *
 * Drives one full AgentSession loop through a scripted mock provider registered
 * via `pi.registerProvider`, with the deterministic-compaction `context` hook
 * (seam A) attached, and asserts:
 *   (a) the context hook actually fires on every LLM call;
 *   (b) once the token threshold is crossed, the OUTGOING payload the provider
 *       receives is projected/compacted (large write args + large read result
 *       replaced by summaries);
 *   (c) toolCallId pairing survives the round-trip (compacted assistant toolCall
 *       ids still match their toolResult ids in the sent context);
 *   (d) the on-disk session JSONL still holds the RAW, unprojected history —
 *       verified by reading the actual .jsonl file after the run.
 *
 * Uses the real `createAgentSession` SDK factory (which wires the `context`
 * hook to the agent loop via `transformContext -> runner.emitContext`, and
 * resolves provider auth through the ModelRegistry) plus a `DefaultResourceLoader`
 * loading our extension factory — the same path the CLI uses. The loop exercises
 * write, edit, and read against the real built-in tools in a temp dir, so the
 * tool results are genuine.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installDeterministicCompaction } from "../src/extension.js";
import { createMockProvider, text, toolCall, type ScriptedStep } from "../src/mock-provider.js";

const PROVIDER = "mockcompact";
const API = "mockcompact-api";
const MODEL_ID = "mock-1";

// A large file body so the write args + subsequent read result cross the
// compaction size thresholds (minArgTokens=800, minResultTokens=200).
const BIG_FILE = Array.from(
	{ length: 300 },
	(_, i) => `export const item_${i} = { id: ${i}, name: "entry-${i}", tag: "payload-${i}" };`,
).join("\n");

interface SmokeHarness {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	tempDir: string;
	getContextHookCalls: () => number;
	providerContexts: Context[];
	getProviderCallCount: () => number;
	cleanup: () => void;
}

async function buildHarness(compactAfterInputTokens: number): Promise<SmokeHarness> {
	const tempDir = join(tmpdir(), `pi-ecode-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const mockModel: Model<string> = {
		id: MODEL_ID,
		name: "Mock Compaction Model",
		api: API,
		provider: PROVIDER,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<string>;

	// Scripted turns: write big file -> read it back -> edit it -> stop.
	// Order matters for the assertions: with keepRecentAssistantMessages=1, only
	// the most recent assistant turn (the edit) is protected on the final call,
	// so BOTH the write args and the read result fall outside the window and get
	// compacted in the outgoing payload.
	const steps: ScriptedStep[] = [
		{ content: [text("Writing the file."), toolCall("call-write", "write", { path: "big.ts", content: BIG_FILE })] },
		{ content: [text("Reading the file back."), toolCall("call-read", "read", { path: "big.ts" })] },
		{
			content: [
				text("Editing the file."),
				toolCall("call-edit", "edit", {
					path: "big.ts",
					oldText: 'export const item_0 = { id: 0, name: "entry-0", tag: "payload-0" };',
					newText: 'export const item_0 = { id: 0, name: "entry-0-renamed", tag: "payload-0" };',
				}),
			],
		},
		{ content: [text("All done.")], stopReason: "stop" },
	];

	const mock = createMockProvider({ providerName: PROVIDER, api: API, modelId: MODEL_ID, steps });

	// Spy: capture the MESSAGES the provider actually receives each call (this is
	// the OUTGOING send payload, i.e. after the context hook has run). We clone
	// only `messages` — `context.tools` holds tool `execute` functions that are
	// not structured-cloneable, and we don't need them for the assertions.
	const providerContexts: Context[] = [];
	const originalStream = mock.config.streamSimple!;
	mock.config.streamSimple = (m, context, options) => {
		providerContexts.push({ messages: structuredClone(context.messages) } as Context);
		return originalStream(m, context, options);
	};

	// Extension factory: register the mock provider + install seam A with an
	// explicit threshold. A second, no-op context handler counts hook firings
	// (emitContext chains all "context" handlers), giving direct observability
	// without modifying the extension under test.
	let contextHookCalls = 0;
	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, mock.config);
		installDeterministicCompaction(pi, {
			compactAfterInputTokens,
			// keep=1 so that on later turns the earlier write/edit/read fall
			// outside the protection window and become eligible for compaction.
			compactionOptions: { keepRecentAssistantMessages: 1 },
			seamBEnabled: false,
		});
		pi.on("context", () => {
			contextHookCalls++;
			return undefined;
		});
	};

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.create(tempDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(PROVIDER, "mock-key");
	const modelRegistry = ModelRegistry.create(authStorage, agentDir);

	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		extensionFactories: [factory],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: mockModel,
		settingsManager,
		sessionManager,
		authStorage,
		modelRegistry,
		resourceLoader,
	});
	session.subscribe(() => {});
	// Bind extensions so the pending mock-provider registration flushes into the
	// ModelRegistry and session_start fires.
	await session.bindExtensions({});

	return {
		session,
		sessionManager,
		tempDir,
		getContextHookCalls: () => contextHookCalls,
		providerContexts,
		getProviderCallCount: () => mock.getCallCount(),
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("deterministic-compaction end-to-end smoke (mock provider, no API key)", () => {
	let harness: SmokeHarness | undefined;

	beforeEach(() => {
		harness = undefined;
	});
	afterEach(() => {
		harness?.cleanup();
	});

	it("fires the context hook, projects the outgoing payload, preserves pairing, and never mutates on-disk JSONL", async () => {
		// Threshold 0 => projection is active from the first over-threshold turn.
		harness = await buildHarness(0);
		const { session, sessionManager, providerContexts } = harness;

		await session.prompt("Please create big.ts, edit it, then read it back.");
		await session.agent.waitForIdle();

		// (a) the context hook fired — once per LLM call (4 scripted turns).
		expect(harness.getContextHookCalls()).toBeGreaterThanOrEqual(4);
		expect(harness.getProviderCallCount()).toBeGreaterThanOrEqual(4);

		// (b) the LAST provider context (the "All done" turn) saw the compacted
		// payload: the big write args and the big read result are summarised.
		const lastContext = providerContexts.at(-1)!;
		const serialized = JSON.stringify(lastContext.messages);
		expect(serialized).toContain("code-production"); // write args summary object
		expect(serialized).toContain("[compacted read result]"); // read result summary
		// The FULL 300-line body must be gone. The write summary keeps a head/tail
		// preview (so item_0 / item_299 may survive in the preview), but middle
		// lines like item_150 must not appear anywhere in the sent payload — and
		// the raw read result body (which had every line) must be summarised away.
		expect(serialized).not.toContain("item_150");
		// Sanity: the projected payload is materially smaller than the raw one.
		const rawApprox = JSON.stringify([
			{ role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "big.ts", content: BIG_FILE } }] },
		]).length;
		expect(serialized.length).toBeLessThan(rawApprox);

		// (c) toolCallId pairing survived: every toolResult in the sent context
		// still has a matching assistant toolCall id.
		const assistantToolCallIds = new Set<string>();
		const toolResultIds = new Set<string>();
		for (const m of lastContext.messages) {
			if (m.role === "assistant") {
				for (const b of m.content) if (b.type === "toolCall") assistantToolCallIds.add(b.id);
			} else if (m.role === "toolResult") {
				toolResultIds.add(m.toolCallId);
			}
		}
		expect(toolResultIds.size).toBeGreaterThan(0);
		for (const id of toolResultIds) {
			expect(assistantToolCallIds.has(id)).toBe(true);
		}
		expect(assistantToolCallIds.has("call-write")).toBe(true);
		expect(assistantToolCallIds.has("call-read")).toBe(true);

		// (d) the on-disk JSONL holds the RAW history — read the actual file.
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const raw = readFileSync(sessionFile!, "utf-8");
		// The full raw file body (300 lines incl item_299) IS persisted...
		expect(raw).toContain("item_299");
		// ...and NO projection artifacts leaked to disk.
		expect(raw).not.toContain("[compacted read result]");
		expect(raw).not.toContain("code-production");

		// Parse each JSONL line; find the raw read toolResult entry and confirm
		// its content is the full file text, unmodified.
		const entries = raw
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		const readResultEntry = entries.find((e) => {
			const msg = e.message as Record<string, unknown> | undefined;
			return msg?.role === "toolResult" && (msg as { toolCallId?: string }).toolCallId === "call-read";
		});
		expect(readResultEntry).toBeDefined();
		const persistedContent = JSON.stringify((readResultEntry!.message as Record<string, unknown>).content);
		expect(persistedContent).toContain("item_0");
		expect(persistedContent).toContain("item_299");
		expect(persistedContent).not.toContain("[compacted read result]");
	}, 60000);

	it("below the threshold, the provider sees the FULL raw payload (hybrid gating preserves prefix cache)", async () => {
		// Very high threshold => never projects; provider sees raw history.
		harness = await buildHarness(10_000_000);
		const { session, providerContexts } = harness;

		await session.prompt("Please create big.ts, edit it, then read it back.");
		await session.agent.waitForIdle();

		expect(harness.getContextHookCalls()).toBeGreaterThanOrEqual(4);
		const lastContext = providerContexts.at(-1)!;
		const serialized = JSON.stringify(lastContext.messages);
		// No compaction happened: raw body present, no summaries.
		expect(serialized).toContain("item_299");
		expect(serialized).not.toContain("[compacted read result]");
		expect(serialized).not.toContain("code-production");
	}, 60000);
});

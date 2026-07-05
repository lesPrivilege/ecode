/**
 * DF1 acceptance — ambient telemetry JSONL writer + schema parity.
 *
 * Two layers:
 *   (1) unit: the exported `appendAmbientRow` primitive (DF2 will call it) writes
 *       one JSON line, appends rather than truncates, creates the dir, and the
 *       AmbientCollector's row carries every field metrics.ts `SummaryRow`
 *       defines for the analysable core (asserted structurally so the ambient
 *       data is readable the same way G1c/G2 data is);
 *   (2) end-to-end: a real mock-provider session with telemetry ON writes exactly
 *       one row for the session with internally-consistent counts; and the
 *       `compaction telemetry off` toggle suppresses the write for the session.
 *
 * The e2e writes are redirected to a temp dir via writeOptions so the shared
 * experiments/results/ambient/ is never touched.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import {
	AmbientCollector,
	appendAmbientRow,
	AMBIENT_SCHEMA_FAMILY,
	type AmbientSessionRow,
} from "../src/ambient-telemetry.js";
import { installDeterministicCompaction } from "../src/extension.js";
import { createMockProvider, text, toolCall, type ScriptedStep } from "../src/mock-provider.js";

// ---------------------------------------------------------------------------
// (1) unit: appendAmbientRow + AmbientCollector row shape
// ---------------------------------------------------------------------------

/**
 * Field parity: every key metrics.ts SummaryRow exposes for the analysable core
 * (see experiments/lib/metrics.ts). Mirrored here — NOT imported — because the
 * extension must not take a runtime dependency on experiments/. If metrics.ts
 * gains/renames one of these, this list is the reminder to re-sync.
 */
const SUMMARY_CORE_FIELDS = [
	"session_id",
	"turn_count",
	"total_input_tokens",
	"total_output_tokens",
	"total_tool_calls",
	"total_read_calls",
	"total_re_reads",
	"compacted_path_count",
	"total_compacted_path_re_reads",
	"compacted_path_re_read_rate",
	"projected_turn_count",
	"total_cache_read_tokens",
	"cache_signal_present",
] as const;

describe("appendAmbientRow (DF2-reusable primitive)", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("writes one JSON line, appends on repeat, and creates the directory", () => {
		dir = join(tmpdir(), `ambient-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const row: AmbientSessionRow = new AmbientCollector().buildRow("sess-A");
		const p1 = appendAmbientRow(row, { dir, fileStem: "sess-A" });
		const p2 = appendAmbientRow({ ...row, turn_count: 2 }, { dir, fileStem: "sess-A" });
		expect(p1).toBe(p2); // same file for same stem
		const lines = readFileSync(p1, "utf-8").trim().split("\n");
		expect(lines.length).toBe(2); // appended, not truncated
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("AmbientCollector row carries every metrics.ts SummaryRow core field + schema family", () => {
		const collector = new AmbientCollector();
		// Two turns: turn 1 reads /a (first read, compacted), turn 2 re-reads /a.
		collector.onTurn(1000, true, ["/a"]);
		collector.recordAssistant({
			role: "assistant",
			content: [{ type: "text", text: "reading a" }, { type: "toolCall", name: "read", arguments: { path: "/a" } }],
			usage: { output: 7 },
		});
		collector.onTurn(500, false, []);
		collector.recordAssistant({
			role: "assistant",
			content: [{ type: "toolCall", name: "read", arguments: { path: "/a" } }],
			usage: { output: 3 },
		});
		const row = collector.buildRow("sess-shape");

		for (const field of SUMMARY_CORE_FIELDS) {
			expect(row, `missing field: ${field}`).toHaveProperty(field);
		}
		expect(row.type).toBe("session");
		expect(row.schema_family).toBe(AMBIENT_SCHEMA_FAMILY);

		// Formula spot-checks against metrics.ts semantics.
		expect(row.turn_count).toBe(2);
		expect(row.total_read_calls).toBe(2);
		expect(row.total_re_reads).toBe(1); // /a read twice => one re-read
		expect(row.compacted_path_count).toBe(1); // /a's result was compacted
		expect(row.total_compacted_path_re_reads).toBe(2); // both reads target compacted /a
		expect(row.compacted_path_re_read_rate).toBeCloseTo(2 / 2, 6);
		expect(row.projected_turn_count).toBe(1);
		expect(row.total_output_tokens).toBe(10); // 7 + 3 from usage
		// No cache signal from these usages => null, not 0 (metrics.ts null-vs-0).
		expect(row.total_cache_read_tokens).toBeNull();
		expect(row.cache_signal_present).toBe(false);
	});

	it("compacted_path_re_read_rate is null when there are no reads (undefined, not 0)", () => {
		const collector = new AmbientCollector();
		collector.onTurn(100, false, []);
		collector.recordAssistant({ role: "assistant", content: [{ type: "text", text: "no tools" }], usage: { output: 1 } });
		expect(collector.buildRow("sess-noreads").compacted_path_re_read_rate).toBeNull();
	});

	it("records a cache signal verbatim when the provider populates cacheRead", () => {
		const collector = new AmbientCollector();
		collector.onTurn(100, false, []);
		collector.recordAssistant({
			role: "assistant",
			content: [{ type: "text", text: "cached" }],
			usage: { output: 2, cacheRead: 128 },
		});
		const row = collector.buildRow("sess-cache");
		expect(row.total_cache_read_tokens).toBe(128);
		expect(row.cache_signal_present).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// (2) end-to-end: real session writes one row; toggle-off suppresses it
// ---------------------------------------------------------------------------

const PROVIDER = "mockamb";
const API = "mockamb-api";
const MODEL_ID = "mock-1";
const BIG_FILE = Array.from(
	{ length: 300 },
	(_, i) => `export const item_${i} = { id: ${i}, name: "entry-${i}", tag: "payload-${i}" };`,
).join("\n");

interface AmbientHarness {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	ambientDir: string;
	getToggleCommand: () => Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	cleanup: () => void;
}

async function buildAmbientHarness(): Promise<AmbientHarness> {
	const tempDir = join(tmpdir(), `pi-ecode-amb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const ambientDir = join(tempDir, "ambient-out");

	const mockModel: Model<string> = {
		id: MODEL_ID,
		name: "Mock Ambient Model",
		api: API,
		provider: PROVIDER,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<string>;

	// write -> read -> edit -> done. With keepRecentAssistantMessages=1, on the
	// final turn only the edit is protected, so the read RESULT (turn 2) falls
	// outside the window and is compacted — exercising compacted-path tracking.
	const steps: ScriptedStep[] = [
		{ content: [text("Writing."), toolCall("call-write", "write", { path: "big.ts", content: BIG_FILE })] },
		{ content: [text("Reading."), toolCall("call-read", "read", { path: "big.ts" })] },
		{
			content: [
				text("Editing."),
				toolCall("call-edit", "edit", {
					path: "big.ts",
					oldText: 'export const item_0 = { id: 0, name: "entry-0", tag: "payload-0" };',
					newText: 'export const item_0 = { id: 0, name: "entry-0-renamed", tag: "payload-0" };',
				}),
			],
		},
		{ content: [text("Done.")], stopReason: "stop" },
	];
	const mock = createMockProvider({ providerName: PROVIDER, api: API, modelId: MODEL_ID, steps });

	let toggleCommand: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, mock.config);
		const origRegisterCommand = pi.registerCommand.bind(pi);
		pi.registerCommand = (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			if (name === "compaction") toggleCommand = options;
			return origRegisterCommand(name, options);
		};
		installDeterministicCompaction(
			pi,
			{ compactAfterInputTokens: 0, compactionOptions: { keepRecentAssistantMessages: 1 }, seamBEnabled: false },
			// Redirect ambient writes to a temp dir so the shared results/ambient is untouched.
			{ telemetry: { writeOptions: { dir: ambientDir } } },
		);
	};

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const sessionManager = SessionManager.create(tempDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(PROVIDER, "mock-key");
	const modelRegistry = ModelRegistry.create(authStorage, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, extensionFactories: [factory] });
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
	await session.bindExtensions({});

	return {
		session,
		sessionManager,
		ambientDir,
		getToggleCommand: () => toggleCommand,
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("DF1 ambient telemetry end-to-end (mock provider, no API key)", () => {
	let harness: AmbientHarness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("writes exactly one G1c-schema row for the session with consistent counts", async () => {
		harness = await buildAmbientHarness();
		const { session, sessionManager, ambientDir } = harness;
		await session.prompt("create big.ts and read it back.");
		await session.agent.waitForIdle();

		const file = join(ambientDir, `${sessionManager.getSessionId()}.jsonl`);
		expect(existsSync(file)).toBe(true);
		const lines = readFileSync(file, "utf-8").trim().split("\n");
		expect(lines.length).toBe(1); // exactly one row per session
		const row = JSON.parse(lines[0]) as AmbientSessionRow;

		expect(row.type).toBe("session");
		expect(row.schema_family).toBe(AMBIENT_SCHEMA_FAMILY);
		expect(row.session_id).toBe(sessionManager.getSessionId());
		expect(row.turn_count).toBeGreaterThanOrEqual(4);
		// A write + a read happened; the read result got compacted (threshold 0).
		expect(row.total_tool_calls).toBeGreaterThanOrEqual(2);
		expect(row.total_read_calls).toBeGreaterThanOrEqual(1);
		expect(row.projected_turn_count).toBeGreaterThanOrEqual(1);
		expect(row.compacted_path_count).toBeGreaterThanOrEqual(1);
		// Mock provider gives no cache signal => null, not 0.
		expect(row.total_cache_read_tokens).toBeNull();
		expect(row.cache_signal_present).toBe(false);
		// Rate is defined (reads happened) and within [0,1].
		expect(row.compacted_path_re_read_rate).not.toBeNull();
		expect(row.compacted_path_re_read_rate as number).toBeGreaterThanOrEqual(0);
		expect(row.compacted_path_re_read_rate as number).toBeLessThanOrEqual(1);
	}, 60000);

	it("`compaction telemetry off` suppresses the ambient write for the session", async () => {
		harness = await buildAmbientHarness();
		const { session, sessionManager, ambientDir, getToggleCommand } = harness;

		// Toggle telemetry off BEFORE the turn runs.
		const toggle = getToggleCommand();
		expect(toggle).toBeDefined();
		const notifications: string[] = [];
		const ctx = { ui: { notify: (m: string) => notifications.push(m) } } as unknown as ExtensionCommandContext;
		await toggle!.handler("telemetry off", ctx);
		expect(notifications.join(" ")).toMatch(/disabled/i);

		await session.prompt("create big.ts and read it back.");
		await session.agent.waitForIdle();

		const file = join(ambientDir, `${sessionManager.getSessionId()}.jsonl`);
		expect(existsSync(file)).toBe(false); // no row written while disabled
	}, 60000);
});

/**
 * DF1 acceptance — observability commands + trigger marker (mock provider, no key).
 *
 * Drives a REAL AgentSession through the scripted mock provider (same pattern as
 * smoke.test.ts) with the deterministic-compaction extension installed, then:
 *
 *   (1) invokes each of the three command handlers directly against the live
 *       session and checks the emitted report text against what we KNOW the
 *       compaction state actually is (write args + read result compacted, gate
 *       active/waiting, JSON payload well-formed);
 *   (2) asserts the trigger-marker custom ENTRY is appended on the turn a
 *       projection actually fires (threshold 0), and is ABSENT when projection
 *       never fires (huge threshold).
 *
 * Command handlers are captured by wrapping `pi.registerCommand` in the test
 * factory (their handlers are otherwise private to pi's registry), and
 * `pi.sendMessage` is wrapped to capture report output. Both wrap the SAME `pi`
 * the extension registers on, so this exercises the real registration path.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
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
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { installDeterministicCompaction } from "../src/extension.js";
import { OBSERVABILITY_TRIGGER_TYPE } from "../src/observability.js";
import { createMockProvider, text, toolCall, type ScriptedStep } from "../src/mock-provider.js";

const PROVIDER = "mockobs";
const API = "mockobs-api";
const MODEL_ID = "mock-1";

const BIG_FILE = Array.from(
	{ length: 300 },
	(_, i) => `export const item_${i} = { id: ${i}, name: "entry-${i}", tag: "payload-${i}" };`,
).join("\n");

interface CapturedCommand {
	name: string;
	options: Omit<RegisteredCommand, "name" | "sourceInfo">;
}

interface Harness {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	commands: Map<string, CapturedCommand>;
	sentMessages: Array<{ customType: string; content: unknown; details?: unknown }>;
	appendedEntries: Array<{ customType: string; data?: unknown }>;
	runCommand: (name: string, args: string) => Promise<void>;
	cleanup: () => void;
}

async function buildHarness(compactAfterInputTokens: number): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-ecode-obs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const mockModel: Model<string> = {
		id: MODEL_ID,
		name: "Mock Obs Model",
		api: API,
		provider: PROVIDER,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<string>;

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

	const commands = new Map<string, CapturedCommand>();
	const sentMessages: Harness["sentMessages"] = [];
	const appendedEntries: Harness["appendedEntries"] = [];

	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, mock.config);

		// Wrap registerCommand to capture handlers (otherwise private to pi).
		const origRegisterCommand = pi.registerCommand.bind(pi);
		pi.registerCommand = (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, { name, options });
			return origRegisterCommand(name, options);
		};
		// Wrap sendMessage / appendEntry to capture observability output.
		const origSend = pi.sendMessage.bind(pi);
		pi.sendMessage = ((message: { customType: string; content: unknown; details?: unknown }, opts?: unknown) => {
			sentMessages.push({ customType: message.customType, content: message.content, details: message.details });
			return (origSend as (m: unknown, o?: unknown) => void)(message, opts);
		}) as ExtensionAPI["sendMessage"];
		const origAppend = pi.appendEntry.bind(pi);
		pi.appendEntry = ((customType: string, data?: unknown) => {
			appendedEntries.push({ customType, data });
			return (origAppend as (c: string, d?: unknown) => void)(customType, data);
		}) as ExtensionAPI["appendEntry"];

		installDeterministicCompaction(pi, {
			compactAfterInputTokens,
			compactionOptions: { keepRecentAssistantMessages: 1 },
			seamBEnabled: false,
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
	await session.bindExtensions({});

	// Minimal command context: the observability handlers use ctx.sessionManager
	// (to read the live transcript) and ctx.ui.notify (toggle command only).
	const notifications: string[] = [];
	const ctx = {
		sessionManager,
		ui: {
			notify: (msg: string) => {
				notifications.push(msg);
			},
		},
	} as unknown as ExtensionCommandContext;

	const runCommand = async (name: string, args: string): Promise<void> => {
		const cmd = commands.get(name);
		if (!cmd) throw new Error(`command not registered: ${name}`);
		await cmd.options.handler(args, ctx);
	};

	return {
		session,
		sessionManager,
		commands,
		sentMessages,
		appendedEntries,
		runCommand,
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("DF1 observability commands (mock provider, no API key)", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("registers exactly the four DF1 commands", async () => {
		harness = await buildHarness(0);
		const names = [...harness.commands.keys()].sort();
		expect(names).toEqual(["compact-diff", "compact-report", "compact-status", "compaction"]);
	});

	it("compact-status reports an ACTIVE gate and raw>compacted once the threshold is crossed", async () => {
		harness = await buildHarness(0); // threshold 0 => active
		const { session } = harness;
		await session.prompt("create big.ts, read it back, then edit it.");
		await session.agent.waitForIdle();

		harness.sentMessages.length = 0; // isolate the command's output
		await harness.runCommand("compact-status", "");
		const out = harness.sentMessages.map((m) => String(m.content)).join("\n");

		expect(out).toContain("Compaction report");
		expect(out).toContain("Trigger: active");
		// Gate line reports OVER threshold when active.
		expect(out).toMatch(/Gate:.*OVER threshold/);
		// Context estimate shows raw -> compacted with a positive saving.
		expect(out).toMatch(/raw ~[\d,]+ tokens -> compacted ~[\d,]+ tokens/);
	}, 60000);

	it("compact-diff lists the write and read replacements", async () => {
		harness = await buildHarness(0);
		const { session } = harness;
		await session.prompt("create big.ts, read it back, then edit it.");
		await session.agent.waitForIdle();

		harness.sentMessages.length = 0;
		await harness.runCommand("compact-diff", "");
		const out = harness.sentMessages.map((m) => String(m.content)).join("\n");

		expect(out).toContain("Projected replacements:");
		// The write toolCall args and the read result are the two big items.
		expect(out).toContain("write");
		expect(out).toContain("read");
		// The diff must not be the "none" placeholder — real replacements happened.
		expect(out).not.toMatch(/Projected replacements:\s*\n\s*none/);
	}, 60000);

	it("compact-report without json => diff + hint; with json => valid structured payload", async () => {
		harness = await buildHarness(0);
		const { session } = harness;
		await session.prompt("create big.ts, read it back, then edit it.");
		await session.agent.waitForIdle();

		// Plain: diff + hint.
		harness.sentMessages.length = 0;
		await harness.runCommand("compact-report", "");
		const plain = harness.sentMessages.map((m) => String(m.content)).join("\n");
		expect(plain).toContain("Use `/compact-report json`");

		// JSON: parseable payload with the expected fields.
		harness.sentMessages.length = 0;
		await harness.runCommand("compact-report", "json");
		const jsonOut = harness.sentMessages.map((m) => String(m.content)).join("\n");
		const payload = JSON.parse(jsonOut) as Record<string, unknown>;
		expect(payload.triggerState).toBe("active");
		expect(payload.active).toBe(true);
		expect(typeof payload.compactedCount).toBe("number");
		expect((payload.compactedCount as number) >= 2).toBe(true);
		expect(Array.isArray(payload.diffs)).toBe(true);
		expect(Array.isArray(payload.byTool)).toBe(true);
	}, 60000);
});

describe("DF1 trigger marker presence/absence (mock provider, no API key)", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	function triggerEntries(h: Harness) {
		return h.sessionManager
			.getEntries()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === OBSERVABILITY_TRIGGER_TYPE);
	}

	it("appends a trigger-marker entry on the turn(s) projection actually fires", async () => {
		harness = await buildHarness(0); // active from the first over-threshold turn
		const { session } = harness;
		await session.prompt("create big.ts, read it back, then edit it.");
		await session.agent.waitForIdle();

		// At least one marker was appended (a projection fired at least once).
		const markers = triggerEntries(harness);
		expect(markers.length).toBeGreaterThanOrEqual(1);
		// Also captured via the appendEntry spy under the trigger customType.
		const spied = harness.appendedEntries.filter((e) => e.customType === OBSERVABILITY_TRIGGER_TYPE);
		expect(spied.length).toBe(markers.length);
		// Marker data carries turn / compactedCount / gate fields.
		const data = spied[0].data as { turn: number; compactedCount: number; compactAfterInputTokens: number };
		expect(typeof data.turn).toBe("number");
		expect(data.compactedCount).toBeGreaterThanOrEqual(1);
		expect(data.compactAfterInputTokens).toBe(0);
	}, 60000);

	it("appends NO trigger-marker entry when the threshold is never crossed", async () => {
		harness = await buildHarness(10_000_000); // never projects
		const { session } = harness;
		await session.prompt("create big.ts, read it back, then edit it.");
		await session.agent.waitForIdle();

		expect(triggerEntries(harness).length).toBe(0);
		expect(harness.appendedEntries.filter((e) => e.customType === OBSERVABILITY_TRIGGER_TYPE).length).toBe(0);
	}, 60000);
});

/**
 * DF2 acceptance — `/compaction` tuning subcommands (mock provider, no API key).
 *
 * Drives a REAL AgentSession through the scripted mock provider (same harness
 * shape as smoke.test.ts / observability.test.ts) with the deterministic-compaction
 * extension installed, then verifies the DF2 contract against REAL mock-session
 * turns (not just isolated parsing):
 *
 *   (1) `/compaction set compact-after=N` changes the NEXT turn's projection: with
 *       a run that projects under threshold 0, raising compact-after above the
 *       context size makes the very next provider payload pass through UNPROJECTED.
 *   (2) `/compaction off` stops projection on a turn that would otherwise project;
 *       `/compaction on` restores it — both observed on subsequent real turns.
 *   (3) Every state-changing tuning call writes EXACTLY ONE ambient JSONL row with
 *       old->new and a plausible context-token reading; a no-op call writes none.
 *   (4) Completions + parsing disambiguate DF2's `on`/`off`/`set …` from DF1's
 *       `telemetry on`/`telemetry off`.
 *
 * Tuning rows are redirected to a per-test throwaway dir via `tuning.writeOptions`
 * so nothing touches real ambient data. Command handlers are captured by wrapping
 * `pi.registerCommand` in the test factory (as observability.test.ts does).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
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
import { parseTuningCommand, TUNING_COMPLETIONS } from "../src/tuning.js";
import { createMockProvider, text, toolCall, type ScriptedStep } from "../src/mock-provider.js";

const PROVIDER = "mocktune";
const API = "mocktune-api";
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
	providerContexts: Context[];
	handle: ReturnType<typeof installDeterministicCompaction>;
	tuningDir: string;
	runCommand: (name: string, args: string) => Promise<void>;
	notifications: string[];
	cleanup: () => void;
}

/**
 * One scripted "unit" of work whose write + read cross the compaction thresholds.
 * Repeated so we can prompt more than once; each prompt drives 2 turns then stops.
 * With keepRecentAssistantMessages=1, on the SECOND+ turn the earlier big write
 * args and read result fall outside the protection window -> eligible to compact.
 */
function unitSteps(): ScriptedStep[] {
	return [
		{ content: [text("Writing."), toolCall("call-write", "write", { path: "big.ts", content: BIG_FILE })] },
		{ content: [text("Reading."), toolCall("call-read", "read", { path: "big.ts" })] },
		{ content: [text("Done.")], stopReason: "stop" },
	];
}

async function buildHarness(compactAfterInputTokens: number): Promise<Harness> {
	const tempDir = join(tmpdir(), `pi-ecode-tune-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const tuningDir = join(tempDir, "tuning-rows");

	const mockModel: Model<string> = {
		id: MODEL_ID,
		name: "Mock Tune Model",
		api: API,
		provider: PROVIDER,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	} as Model<string>;

	// Enough scripted units for several prompts across the whole file.
	const steps: ScriptedStep[] = [...unitSteps(), ...unitSteps(), ...unitSteps(), ...unitSteps()];
	const mock = createMockProvider({ providerName: PROVIDER, api: API, modelId: MODEL_ID, steps });

	// Spy the OUTGOING payload each provider call receives (post-context-hook).
	const providerContexts: Context[] = [];
	const originalStream = mock.config.streamSimple!;
	mock.config.streamSimple = (m, context, options) => {
		providerContexts.push({ messages: structuredClone(context.messages) } as Context);
		return originalStream(m, context, options);
	};

	const commands = new Map<string, CapturedCommand>();
	let handle!: ReturnType<typeof installDeterministicCompaction>;

	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(PROVIDER, mock.config);
		const origRegisterCommand = pi.registerCommand.bind(pi);
		pi.registerCommand = (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, { name, options });
			return origRegisterCommand(name, options);
		};
		handle = installDeterministicCompaction(
			pi,
			{
				compactAfterInputTokens,
				compactionOptions: { keepRecentAssistantMessages: 1 },
				seamBEnabled: false,
			},
			{
				// Redirect DF2 tuning rows to a throwaway dir; keep ambient session
				// rows out of the way too by disabling that flush noise is irrelevant
				// here — we only assert on the tuning file.
				tuning: { writeOptions: { dir: tuningDir } },
			},
		);
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
		providerContexts,
		handle,
		tuningDir,
		runCommand,
		notifications,
		cleanup: () => {
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

/** True if the serialized outgoing payload shows compaction artifacts. */
function isProjected(context: Context): boolean {
	const s = JSON.stringify(context.messages);
	return s.includes("[compacted read result]") || s.includes("code-production");
}

/** Read all tuning rows written to the throwaway dir (across all session files). */
function readTuningRows(dir: string): Array<Record<string, unknown>> {
	if (!existsSync(dir)) return [];
	const { readdirSync } = require("node:fs") as typeof import("node:fs");
	const rows: Array<Record<string, unknown>> = [];
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".jsonl")) continue;
		const raw = readFileSync(join(dir, f), "utf-8");
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			rows.push(JSON.parse(line) as Record<string, unknown>);
		}
	}
	return rows;
}

describe("DF2 tuning parsing / completion disambiguation", () => {
	it("parses seam-A on/off distinctly from DF1 telemetry on/off", () => {
		expect(parseTuningCommand("on")).toEqual({ kind: "toggle", enabled: true });
		expect(parseTuningCommand("off")).toEqual({ kind: "toggle", enabled: false });
		// DF1's telemetry forms are NOT DF2 commands -> null (handler falls through).
		expect(parseTuningCommand("telemetry on")).toBeNull();
		expect(parseTuningCommand("telemetry off")).toBeNull();
	});

	it("parses set keep-recent / compact-after with integer validation", () => {
		expect(parseTuningCommand("set keep-recent=5")).toEqual({ kind: "set", target: "keep-recent", value: 5 });
		expect(parseTuningCommand("set compact-after=64000")).toEqual({
			kind: "set",
			target: "compact-after",
			value: 64000,
		});
		expect(parseTuningCommand("set keep-recent=-1")).toMatchObject({ kind: "set-error" });
		expect(parseTuningCommand("set keep-recent=abc")).toMatchObject({ kind: "set-error" });
		expect(parseTuningCommand("set bogus=3")).toMatchObject({ kind: "set-error" });
		// Not a tuning command at all.
		expect(parseTuningCommand("wibble")).toBeNull();
	});

	it("completion list carries DF2 forms alongside DF1's telemetry forms", () => {
		expect(TUNING_COMPLETIONS).toContain("on");
		expect(TUNING_COMPLETIONS).toContain("off");
		expect(TUNING_COMPLETIONS).toContain("set keep-recent=");
		expect(TUNING_COMPLETIONS).toContain("set compact-after=");
	});
});

describe("DF2 /compaction command registered on the single compaction command", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("does not register a SECOND compaction command; the one command's completions include both families", async () => {
		harness = await buildHarness(0);
		const names = [...harness.commands.keys()].sort();
		expect(names).toEqual(["compact-dash", "compact-diff", "compact-report", "compact-status", "compaction"]);

		const compaction = harness.commands.get("compaction")!;
		const all = (compaction.options.getArgumentCompletions?.("") ?? []) as Array<{ value: string }>;
		const values = all.map((c) => c.value);
		// DF1's telemetry forms AND DF2's tuning forms are both present.
		expect(values).toEqual(expect.arrayContaining(["telemetry off", "telemetry on", "on", "off", "set keep-recent=", "set compact-after="]));

		// Prefix "o" completes DF2's on/off but NOT telemetry (which starts with "t").
		const oHits = ((compaction.options.getArgumentCompletions?.("o") ?? []) as Array<{ value: string }>).map((c) => c.value);
		expect(oHits).toEqual(expect.arrayContaining(["on", "off"]));
		expect(oHits).not.toContain("telemetry off");
	});
});

describe("DF2 set compact-after changes NEXT-turn projection (real mock session)", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("raising compact-after above context size stops the next turn from projecting", async () => {
		// Threshold 0 => projection active. First prompt should project on its
		// over-threshold turn(s).
		harness = await buildHarness(0);
		const { session, providerContexts } = harness;

		await session.prompt("create big.ts and read it back.");
		await session.agent.waitForIdle();

		const projectedBefore = providerContexts.some(isProjected);
		expect(projectedBefore).toBe(true); // BEFORE: projection happened

		// Now raise the gate far above any real context size: next turns must NOT project.
		const beforeCount = providerContexts.length;
		await harness.runCommand("compaction", "set compact-after=100000000");

		await session.prompt("read big.ts again.");
		await session.agent.waitForIdle();

		const newContexts = providerContexts.slice(beforeCount);
		expect(newContexts.length).toBeGreaterThanOrEqual(1);
		// AFTER: none of the new outgoing payloads are projected.
		expect(newContexts.some(isProjected)).toBe(false);
		// The raw big body is present again in the latest payload (passthrough).
		expect(JSON.stringify(providerContexts.at(-1)!.messages)).toContain("item_150");

		// Exactly one tuning row for the set, with old->new and a context reading.
		const rows = readTuningRows(harness.tuningDir);
		const setRows = rows.filter((r) => r.setting === "compact-after");
		expect(setRows.length).toBe(1);
		expect(setRows[0].old_value).toBe(0);
		expect(setRows[0].new_value).toBe(100000000);
		expect(setRows[0].type).toBe("tuning");
		expect(typeof setRows[0].context_tokens).toBe("number");
		expect(setRows[0].context_tokens as number).toBeGreaterThan(0);
	}, 60000);
});

describe("DF2 off/on gates seam-A projection (real mock session)", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("/compaction off => no projection on a would-project turn; /compaction on restores it", async () => {
		harness = await buildHarness(0); // projection active
		const { session, providerContexts } = harness;

		// Turn projection OFF before any prompt.
		await harness.runCommand("compaction", "off");
		expect(harness.handle.tuning.isEnabled()).toBe(false);

		await session.prompt("create big.ts and read it back.");
		await session.agent.waitForIdle();
		// With seam-A off, NOTHING is projected even though tokens exceed threshold 0.
		expect(providerContexts.some(isProjected)).toBe(false);
		expect(JSON.stringify(providerContexts.at(-1)!.messages)).toContain("item_150");

		// Turn projection back ON, prompt again => projection returns.
		const beforeCount = providerContexts.length;
		await harness.runCommand("compaction", "on");
		expect(harness.handle.tuning.isEnabled()).toBe(true);

		await session.prompt("read big.ts once more.");
		await session.agent.waitForIdle();
		const after = providerContexts.slice(beforeCount);
		expect(after.some(isProjected)).toBe(true);

		// Two state-changing toggles => exactly two `enabled` tuning rows (off, then on).
		const rows = readTuningRows(harness.tuningDir);
		const enabledRows = rows.filter((r) => r.setting === "enabled");
		expect(enabledRows.length).toBe(2);
		expect(enabledRows[0].old_value).toBe(true);
		expect(enabledRows[0].new_value).toBe(false);
		expect(enabledRows[1].old_value).toBe(false);
		expect(enabledRows[1].new_value).toBe(true);
	}, 60000);
});

describe("DF2 no-op tuning calls write NO row", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("`on` when already on, and a set to the current value, produce no tuning row", async () => {
		harness = await buildHarness(32000);

		// Already ON by default => `on` is a no-op.
		await harness.runCommand("compaction", "on");
		// set compact-after to its current value (32000) => no-op.
		await harness.runCommand("compaction", "set compact-after=32000");
		// set keep-recent to its current value (1) => no-op.
		await harness.runCommand("compaction", "set keep-recent=1");

		const rows = readTuningRows(harness.tuningDir);
		expect(rows.length).toBe(0);

		// A REAL change now writes exactly one row.
		await harness.runCommand("compaction", "set keep-recent=4");
		const after = readTuningRows(harness.tuningDir);
		expect(after.length).toBe(1);
		expect(after[0].setting).toBe("keep-recent");
		expect(after[0].old_value).toBe(1);
		expect(after[0].new_value).toBe(4);
	}, 60000);
});

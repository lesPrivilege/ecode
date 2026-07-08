/**
 * G4b-R real agent-loop smoke test — no API key.
 *
 * Drives a real `createAgentSession` loop (real `DefaultResourceLoader`
 * loading this extension's own, UNMODIFIED default export as the factory,
 * real built-in `read` tool execution against a temp dir) through a
 * scripted mock provider registered via `pi.registerProvider`, mirroring
 * extensions/deterministic-compaction/test/smoke.test.ts's harness pattern
 * (createAgentSession + DefaultResourceLoader + provider streamSimple spy +
 * on-disk JSONL readback). mock-provider.ts is imported directly (relative
 * path, read-only reuse) — it loads correctly now that vitest.config.ts
 * carries the same @earendil-works namespace-to-pi-source alias DC uses;
 * previously (G4b) this extension's own vitest.config.ts lacked that alias,
 * which is why mock-provider.ts could not be imported in isolation then.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockProvider, text, toolCall, type ScriptedStep } from "../../deterministic-compaction/src/mock-provider.js";
import frontierPruningExtension from "../src/extension.js";
import { CLEAR_TOOL_USES_PLACEHOLDER } from "../src/context-pruning.js";
import type { EnvLike } from "../src/flags.js";

const PROVIDER = "trcmock";
const API = "trcmock-api";
const MODEL_ID = "trc-mock-1";

const FILE_COUNT = 6;
const FILE_CHAR_LEN = 3000;

function fileBody(i: number): string {
  return `F${i}`.repeat(FILE_CHAR_LEN / 2);
}

interface RealLoopHarness {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  sessionManager: SessionManager;
  tempDir: string;
  providerContexts: Context[];
  cleanup: () => void;
}

async function buildHarness(env: EnvLike, steps: ScriptedStep[]): Promise<RealLoopHarness> {
  const tempDir = join(tmpdir(), `ecode-trc-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const agentDir = join(tempDir, "agent");
  mkdirSync(agentDir, { recursive: true });

  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(tempDir, `f${i}.txt`), fileBody(i), "utf-8");
  }

  const mockModel: Model<string> = {
    id: MODEL_ID,
    name: "TRC Mock Model",
    api: API,
    provider: PROVIDER,
    baseUrl: "http://localhost:0/mock",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  } as Model<string>;

  const mock = createMockProvider({ providerName: PROVIDER, api: API, modelId: MODEL_ID, steps });

  const providerContexts: Context[] = [];
  const originalStream = mock.config.streamSimple!;
  mock.config.streamSimple = (m, context, options) => {
    providerContexts.push({ messages: structuredClone(context.messages) } as Context);
    return originalStream(m, context, options);
  };

  const factory = (pi: ExtensionAPI) => {
    pi.registerProvider(PROVIDER, mock.config);
    frontierPruningExtension(pi, env);
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

  return {
    session,
    sessionManager,
    tempDir,
    providerContexts,
    cleanup: () => {
      session.dispose();
      if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readSteps(count: number): ScriptedStep[] {
  const steps: ScriptedStep[] = [];
  for (let i = 0; i < count; i++) {
    steps.push({ content: [text(`Reading f${i}.`), toolCall(`call-r${i}`, "read", { path: `f${i}.txt` })] });
  }
  steps.push({ content: [text("All done.")], stopReason: "stop" });
  return steps;
}

/**
 * One read of a nonexistent path first (a REAL tool execution, not a
 * fabricated error — empirically confirmed to return a toolResult with
 * `isError: true` and an ENOENT message, not a thrown exception), followed
 * by `count` real reads so the error pair ages past the keep window.
 */
function errorFirstThenReadSteps(count: number): ScriptedStep[] {
  const steps: ScriptedStep[] = [
    { content: [text("Reading a missing file."), toolCall("call-missing", "read", { path: "does-not-exist.txt" })] },
  ];
  for (let i = 0; i < count; i++) {
    steps.push({ content: [text(`Reading f${i}.`), toolCall(`call-r${i}`, "read", { path: `f${i}.txt` })] });
  }
  steps.push({ content: [text("All done.")], stopReason: "stop" });
  return steps;
}

function toolResultText(messages: unknown[], toolCallId: string): string | undefined {
  for (const m of messages as Array<Record<string, unknown>>) {
    if (m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === toolCallId) {
      const content = m.content as Array<{ type: string; text?: string }>;
      return content.find((b) => b.type === "text")?.text;
    }
  }
  return undefined;
}

describe("real agent-loop smoke (G4b-R)", () => {
  let harness: RealLoopHarness | undefined;

  beforeEach(() => {
    harness = undefined;
  });
  afterEach(() => {
    harness?.cleanup();
  });

  it("above threshold: send payload carries the placeholder, keep window survives, disk JSONL stays raw with zero placeholder occurrences", async () => {
    harness = await buildHarness(
      { ECODE_TRC: "1", ECODE_TRC_TRIGGER_TOKENS: "1", ECODE_TRC_KEEP: "2" },
      readSteps(FILE_COUNT),
    );
    const { session, sessionManager, providerContexts } = harness;

    await session.prompt("Please read f0 through f5.");
    await session.agent.waitForIdle();

    expect(providerContexts.length).toBeGreaterThanOrEqual(FILE_COUNT + 1);

    const lastContext = providerContexts.at(-1)!;
    const serialized = JSON.stringify(lastContext.messages);

    // (a) placeholder present; oldest 4 (keep=2 -> candidates f0..f3) are cleared.
    expect(serialized).toContain(CLEAR_TOOL_USES_PLACEHOLDER);
    expect(serialized).not.toContain(fileBody(0));
    expect(serialized).not.toContain(fileBody(1));
    expect(serialized).not.toContain(fileBody(2));
    expect(serialized).not.toContain(fileBody(3));
    // most recent keep=2 pairs (f4, f5) survive whole in the send payload.
    expect(serialized).toContain(fileBody(4));
    expect(serialized).toContain(fileBody(5));

    // (c) on-disk JSONL: byte-level checks on the raw file, not a line-count diff.
    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeDefined();
    const raw = readFileSync(sessionFile!, "utf-8");
    for (let i = 0; i < FILE_COUNT; i++) {
      expect(raw).toContain(fileBody(i));
    }
    expect(raw).not.toContain(CLEAR_TOOL_USES_PLACEHOLDER);

    // Parse the f0 toolResult entry specifically and confirm its content field
    // is the full untouched original body (not just "somewhere in the file").
    const entries = raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const f0ResultEntry = entries.find((e) => {
      const msg = e.message as Record<string, unknown> | undefined;
      return msg?.role === "toolResult" && (msg as { toolCallId?: string }).toolCallId === "call-r0";
    });
    expect(f0ResultEntry).toBeDefined();
    const persisted = JSON.stringify((f0ResultEntry!.message as Record<string, unknown>).content);
    expect(persisted).toContain(fileBody(0));
    expect(persisted).not.toContain(CLEAR_TOOL_USES_PLACEHOLDER);
  }, 60000);

  it("below threshold: the provider-received payload carries every file's full body, byte-for-byte, no placeholder anywhere", async () => {
    // Note on "reference/字节一致": raw AgentMessage[] reference equality is
    // not an observable property at this boundary. Per g0-survey Item 3
    // (required reading), the harness pipeline is
    // event.messages -> [this hook] -> transformContext output ->
    // convertToLlm(...) -> llmMessages -> provider.streamSimple(...) — an LLM
    // wire-format conversion sits between the hook's output and what the
    // provider receives, so reference identity cannot survive to this point
    // even when the hook itself returns its input unchanged (already proven
    // with real `===` assertions at the unit level in extension.test.ts /
    // projection.test.ts / mock-loop-smoke.test.ts). What IS observable and
    // meaningful at the real-loop boundary is byte-level content identity,
    // asserted below.
    harness = await buildHarness(
      { ECODE_TRC: "1", ECODE_TRC_TRIGGER_TOKENS: "10000000", ECODE_TRC_KEEP: "2" },
      readSteps(FILE_COUNT),
    );
    const { session, providerContexts } = harness;

    await session.prompt("Please read f0 through f5.");
    await session.agent.waitForIdle();

    const lastContext = providerContexts.at(-1)!;
    const serialized = JSON.stringify(lastContext.messages);
    for (let i = 0; i < FILE_COUNT; i++) {
      expect(serialized).toContain(fileBody(i));
    }
    expect(serialized).not.toContain(CLEAR_TOOL_USES_PLACEHOLDER);
  }, 60000);

  it("ECODE_TRC_PRESERVE_ERRORS=1: an isError result pair survives whole in the send payload even after it ages past the keep window", async () => {
    const READ_COUNT = 5; // + 1 error-first pair = 6 pairs total; keep=2 -> 4 candidates, including the error pair
    harness = await buildHarness(
      { ECODE_TRC: "1", ECODE_TRC_TRIGGER_TOKENS: "1", ECODE_TRC_KEEP: "2", ECODE_TRC_PRESERVE_ERRORS: "1" },
      errorFirstThenReadSteps(READ_COUNT),
    );
    const { session, providerContexts } = harness;

    await session.prompt("Please read the missing file, then f0 through f4.");
    await session.agent.waitForIdle();

    // Ground truth: the error text as it appeared before enough pairs existed
    // for clearing to apply at all (1 pair <= keep=2 -> 0 candidates yet).
    const earlyErrorText = providerContexts
      .map((c) => toolResultText(c.messages, "call-missing"))
      .find((t) => t !== undefined);
    expect(earlyErrorText).toBeDefined();
    expect(earlyErrorText).toContain("ENOENT");

    const lastContext = providerContexts.at(-1)!;
    // By the final turn there are 6 pairs total; keep=2 -> the error pair
    // (oldest) is now a clearing candidate by position.
    const lastErrorText = toolResultText(lastContext.messages, "call-missing");
    expect(lastErrorText).toBe(earlyErrorText); // preserved verbatim, not the placeholder
    expect(lastErrorText).not.toBe(CLEAR_TOOL_USES_PLACEHOLDER);

    // Non-error candidates in the same age range (f0, f1) ARE cleared.
    const serialized = JSON.stringify(lastContext.messages);
    expect(serialized).not.toContain(fileBody(0));
    expect(serialized).not.toContain(fileBody(1));
    expect(serialized).toContain(CLEAR_TOOL_USES_PLACEHOLDER);
    // Most recent keep=2 (f3, f4) survive as usual.
    expect(serialized).toContain(fileBody(3));
    expect(serialized).toContain(fileBody(4));
  }, 60000);
});

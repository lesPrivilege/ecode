/**
 * End-to-end harness smoke test (runs under vitest, no API key). Drives the SAME
 * in-process path run.ts uses — createAgentSession + the pluggable mock provider +
 * the observer/seam-A hooks — and asserts the metrics collector actually observes
 * the mechanism firing. This complements the CLI smoke runs by pinning the driving
 * path in an automated test (the run is executed here, not assumed).
 *
 * It re-implements the minimal wiring rather than importing run.ts (whose top level
 * parses argv and writes files); the wiring under test — provider, arm config,
 * observer hook, projectContext, RunMetrics — is all shared library code.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { ARMS } from "../lib/arms.js";
import { estimatePayloadTokens, installDeterministicCompaction, projectContext } from "../lib/compaction-core-adapter.js";
import { RunMetrics } from "../lib/metrics.js";
import { resolveProvider } from "../lib/provider.js";
import { getScenario } from "../fixtures/index.js";

interface Harness {
	metrics: RunMetrics;
	provider: ReturnType<typeof resolveProvider>;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	sessionManager: SessionManager;
	cleanup: () => void;
}

async function driveArm(armId: "A" | "B" | "C" | "D", compactAfter: number): Promise<Harness> {
	const arm = ARMS[armId];
	const scenario = getScenario("refactor");
	const provider = resolveProvider("mock", scenario);
	const projectionConfig = { compactAfterInputTokens: compactAfter, compactionOptions: { keepRecentAssistantMessages: 3 } };

	const tempDir = join(tmpdir(), `ecode-runsmoke-${armId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const metrics = new RunMetrics();

	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(provider.providerName, provider.config);
		pi.on("context", (event) => {
			const messages = event.messages as AgentMessage[];
			if (arm.seamAInstalled) {
				const outcome = projectContext(messages, projectionConfig);
				metrics.onOutgoingTokens(estimatePayloadTokens(outcome.messages));
				if (outcome.projected && outcome.compaction) {
					const paths: string[] = [];
					for (const m of outcome.compaction.messages) {
						const c = (m as { role: string; meta?: Record<string, unknown> }).meta?.["compacted"] as
							| { compacted?: string; path?: string }
							| undefined;
						if (c && c.compacted === "read-result" && typeof c.path === "string") paths.push(c.path);
					}
					metrics.noteProjected(paths);
				}
			} else {
				metrics.onOutgoingTokens(estimatePayloadTokens(messages));
			}
			return undefined;
		});
		if (arm.seamAInstalled) {
			installDeterministicCompaction(pi, {
				compactAfterInputTokens: compactAfter,
				compactionOptions: { keepRecentAssistantMessages: 3 },
				seamBEnabled: arm.seamBInstalled,
			});
		}
	};

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	settingsManager.setCompactionEnabled(arm.nativeCompactionEnabled);
	const sessionManager = SessionManager.create(tempDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(provider.providerName, "mock-key");
	const modelRegistry = ModelRegistry.create(authStorage, agentDir);
	const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, extensionFactories: [factory] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: provider.model,
		settingsManager,
		sessionManager,
		authStorage,
		modelRegistry,
		resourceLoader,
	});

	let turn = 0;
	session.subscribe((event: { type: string; [k: string]: unknown }) => {
		if (event.type === "turn_end") {
			const msg = event.message as AgentMessage | undefined;
			if (msg && msg.role === "assistant") {
				turn++;
				const a = msg as AssistantMessage;
				metrics.recordAssistant(turn, a);
				metrics.recordCache(a.usage ? a.usage.cacheRead : null, provider.cacheSignalPresent);
			}
		} else if (event.type === "compaction_start" || event.type === "session_compact") {
			metrics.noteNativeCompaction();
		}
	});
	await session.bindExtensions({});
	await session.prompt(scenario.prompt);
	await session.agent.waitForIdle();
	const summ = provider.getSummarizerTokens();
	metrics.recordSummarizer(summ.calls, summ.inputTokens, summ.outputTokens);

	return {
		metrics,
		provider,
		session,
		sessionManager,
		cleanup: () => {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

describe("run harness end-to-end (mock provider, no API key)", () => {
	let h: Harness | undefined;
	beforeEach(() => {
		h = undefined;
	});
	afterEach(() => {
		h?.cleanup();
	});

	it("arm C crosses the threshold, projects, and records the deliberate compacted-path re-read", async () => {
		h = await driveArm("C", 32000);
		const s = h.metrics.buildSummary({ arm: "C", arm_label: "c", scenario: "refactor", provider: "mock", session_id: "x", workspace: "x" });
		expect(s.turn_count).toBe(10);
		// The scenario is designed to cross 32000 mid-run.
		expect(s.projected_turn_count).toBeGreaterThan(0);
		// The deliberate re-read of mod-a.ts after it was compacted.
		expect(s.total_re_reads).toBeGreaterThanOrEqual(1);
		expect(s.compacted_path_count).toBeGreaterThan(0);
		expect(s.total_compacted_path_re_reads).toBeGreaterThanOrEqual(1);
		// rate = compacted-path re-reads / total reads, in (0,1].
		expect(s.compacted_path_re_read_rate).not.toBeNull();
		expect(s.compacted_path_re_read_rate!).toBeGreaterThan(0);
		// mock provider gives no cache signal -> null, not 0.
		expect(s.total_cache_read_tokens).toBeNull();
		expect(s.cache_signal_present).toBe(false);
	}, 60000);

	it("arm A (baseline) neither projects nor natively compacts, and re-read still tracked", async () => {
		h = await driveArm("A", 32000);
		const s = h.metrics.buildSummary({ arm: "A", arm_label: "a", scenario: "refactor", provider: "mock", session_id: "x", workspace: "x" });
		expect(s.projected_turn_count).toBe(0);
		expect(s.native_compactions_observed).toBe(0);
		expect(s.compacted_path_count).toBe(0);
		// The re-read of mod-a still happens; it is just not a compacted-path re-read.
		expect(s.total_re_reads).toBeGreaterThanOrEqual(1);
		expect(s.total_compacted_path_re_reads).toBe(0);
	}, 60000);

	it("arm B fires pi's native summariser and accounts for its tokens", async () => {
		h = await driveArm("B", 32000);
		const s = h.metrics.buildSummary({ arm: "B", arm_label: "b", scenario: "refactor", provider: "mock", session_id: "x", workspace: "x" });
		expect(s.native_compactions_observed).toBeGreaterThanOrEqual(1);
		expect(s.summarizer_calls).toBeGreaterThanOrEqual(1);
		expect(s.summarizer_input_tokens).toBeGreaterThan(0);
		// Its tokens are folded into the totals (not undercounted).
		expect(s.total_input_tokens).toBeGreaterThan(0);
	}, 60000);

	it("sweep: a lower compact-after projects at least as much as a higher one", async () => {
		const low = await driveArm("C", 16000);
		const lowS = low.metrics.buildSummary({ arm: "C", arm_label: "c", scenario: "refactor", provider: "mock", session_id: "x", workspace: "x" });
		low.cleanup();
		const high = await driveArm("C", 64000);
		h = high;
		const highS = high.metrics.buildSummary({ arm: "C", arm_label: "c", scenario: "refactor", provider: "mock", session_id: "x", workspace: "x" });
		// The sweep parameter is not inert: a much higher threshold projects strictly
		// less on this fixture (64000 is never crossed -> 0 projections).
		expect(highS.projected_turn_count).toBeLessThan(lowS.projected_turn_count);
		expect(highS.total_input_tokens).toBeGreaterThan(lowS.total_input_tokens);
	}, 90000);
});

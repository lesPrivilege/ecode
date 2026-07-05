/**
 * run — drive ONE arm against ONE scenario in-process and emit a JSONL metrics
 * file. In-process (not the `pi` CLI binary): it imports pi's agent-core SDK
 * directly and drives a real AgentSession through the pluggable provider, exactly
 * the approach G1b's smoke test uses.
 *
 * Invoke (needs the pi-source resolver — see lib/loader.mjs):
 *   node --import ./lib/register.mjs run.ts --arm C --scenario refactor \
 *        --out results/refactor-C.jsonl [--compact-after 32000] [--keep-recent 3] \
 *        [--provider mock] [--seam-b]
 *
 * ARM WIRING (see lib/arms.ts):
 *   - native compaction: settingsManager.setCompactionEnabled(arm.nativeCompactionEnabled)
 *     — the public setter that flips the flag `_checkCompaction` reads
 *     (agent-session.ts:1842). Arm A/C/D off, arm B on. No pi patch.
 *   - seam-A / seam-B: installDeterministicCompaction(...) is called only for arms
 *     that need it; arms A/B register NO G1b hook.
 *
 * MEASUREMENT: an OBSERVER `context` hook (always installed, independent of the
 * arm) records per-turn input tokens and — by re-running G1b's own projectContext
 * with the arm's config — learns whether the payload was compacted this turn and
 * which read paths were summarised (for the compacted-path-re-read metric). The
 * observer NEVER mutates the payload (returns undefined), so it does not perturb
 * what the arm's real hook (if any) sends. Session events supply assistant
 * messages (output/usage) and native-compaction firings.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	estimatePayloadTokens,
	installDeterministicCompaction,
	projectContext,
	type ProjectionConfig,
} from "./lib/compaction-core-adapter.js";
import { ARMS, isArmId, DEFAULT_COMPACT_AFTER_INPUT_TOKENS, DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES } from "./lib/arms.js";
import { getScenario } from "./fixtures/index.js";
import { resolveProvider, DEFAULT_PROVIDER } from "./lib/provider.js";
import { RunMetrics, type MetaRow, type MetricRow } from "./lib/metrics.js";

const SCHEMA_VERSION = 1;

// --- arg parsing (dogfood-p0 style) ---------------------------------------

interface Args {
	arm: string;
	scenario: string;
	out?: string;
	provider: string;
	compactAfter: number;
	keepRecent: number;
	seamB: boolean;
}

function parseArgs(argv: string[]): Args {
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			flags[key] = true;
		} else {
			flags[key] = next;
			i++;
		}
	}
	const asNum = (v: string | boolean | undefined, d: number) =>
		typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;
	return {
		arm: typeof flags.arm === "string" ? flags.arm : "C",
		scenario: typeof flags.scenario === "string" ? flags.scenario : "refactor",
		out: typeof flags.out === "string" ? flags.out : undefined,
		provider: typeof flags.provider === "string" ? flags.provider : DEFAULT_PROVIDER,
		compactAfter: asNum(flags["compact-after"], DEFAULT_COMPACT_AFTER_INPUT_TOKENS),
		keepRecent: asNum(flags["keep-recent"] ?? flags["keep-recent-assistant-messages"], DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES),
		// --seam-b forces seam B on regardless of arm default (arm D sets it anyway).
		seamB: flags["seam-b"] === true || flags["seam-b"] === "true",
	};
}

// --- extract compacted read paths from a projection outcome ---------------

/**
 * Which read-result paths did seam-A summarise in this projection? A compacted
 * read result carries meta.compacted = { compacted: "read-result", path }.
 */
function compactedReadPaths(messages: { role: string; meta?: Record<string, unknown> }[]): string[] {
	const paths: string[] = [];
	for (const m of messages) {
		if (m.role !== "tool") continue;
		const compacted = m.meta?.["compacted"] as { compacted?: string; path?: string } | undefined;
		if (compacted && compacted.compacted === "read-result" && typeof compacted.path === "string") {
			paths.push(compacted.path);
		}
	}
	return paths;
}

// --- the run --------------------------------------------------------------

async function run(args: Args): Promise<void> {
	if (!isArmId(args.arm)) throw new Error(`Unknown arm "${args.arm}". Use A, B, C, or D.`);
	const arm = ARMS[args.arm];
	const scenario = getScenario(args.scenario);
	const provider = resolveProvider(args.provider, scenario);

	// seam B: arm default OR explicit --seam-b.
	const seamBInstalled = arm.seamBInstalled || args.seamB;
	// seam A config (only meaningful when seamAInstalled).
	const projectionConfig: ProjectionConfig = {
		compactAfterInputTokens: args.compactAfter,
		compactionOptions: { keepRecentAssistantMessages: args.keepRecent },
	};

	const tempDir = join(tmpdir(), `pi-ecode-run-${arm.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	// seed files if the scenario needs pre-existing content.
	for (const [rel, content] of Object.entries(scenario.seedFiles ?? {})) {
		const p = join(tempDir, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content, "utf-8");
	}

	const metrics = new RunMetrics();

	// Extension factory: register provider, install the arm's real hook(s), and
	// ALWAYS install the observer hook (records metrics; never mutates payload).
	const factory = (pi: ExtensionAPI) => {
		pi.registerProvider(provider.providerName, provider.config);

		// Observer FIRST — pi chains context handlers in registration order
		// (runner.ts emitContext), so registering the observer before the seam-A
		// hook guarantees it sees the RAW pre-compaction payload. It measures input
		// tokens on that raw payload, and runs G1b's own projectContext to learn
		// whether THIS turn crosses the threshold and which read paths get
		// summarised (for the compacted-path metric). The observer NEVER returns a
		// replacement (returns undefined), so the real seam-A hook that runs after
		// it still does the actual projection that reaches the provider. For arms
		// A/B (seamAInstalled=false) it only measures input tokens; projected stays
		// false because no seam-A is in play — matching reality.
		pi.on("context", (event) => {
			const messages = event.messages as AgentMessage[];
			if (arm.seamAInstalled) {
				// Re-derive what the real seam-A hook will send, so input_tokens
				// reflects the ACTUAL (compacted) payload and we learn the compacted
				// read paths. projectContext is idempotent + side-effect free.
				const outcome = projectContext(messages, projectionConfig);
				// Content-based payload estimate: compaction-sensitive (see adapter).
				metrics.onOutgoingTokens(estimatePayloadTokens(outcome.messages));
				if (outcome.projected && outcome.compaction) {
					metrics.noteProjected(compactedReadPaths(outcome.compaction.messages));
				}
			} else {
				// No hook: the raw payload is what gets sent.
				metrics.onOutgoingTokens(estimatePayloadTokens(messages));
			}
			return undefined; // observer never changes the payload
		});

		if (arm.seamAInstalled) {
			installDeterministicCompaction(pi, {
				compactAfterInputTokens: args.compactAfter,
				compactionOptions: { keepRecentAssistantMessages: args.keepRecent },
				seamBEnabled: seamBInstalled,
			});
		}
	};

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	// ARM A's disable + arms C/D isolation: flip the exact flag _checkCompaction reads.
	settingsManager.setCompactionEnabled(arm.nativeCompactionEnabled);

	const sessionManager = SessionManager.create(tempDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	authStorage.setRuntimeApiKey(provider.providerName, "mock-key");
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
		model: provider.model,
		settingsManager,
		sessionManager,
		authStorage,
		modelRegistry,
		resourceLoader,
	});

	// Capture assistant messages (output/usage) and native-compaction firings from
	// the event stream. `turn_end` carries the assistant response for the turn
	// (agent/types.ts AgentEvent). Turn numbering follows arrival order.
	let turnNumber = 0;
	session.subscribe((event: { type: string; [k: string]: unknown }) => {
		if (event.type === "turn_end") {
			const msg = event.message as AgentMessage | undefined;
			if (msg && msg.role === "assistant") {
				turnNumber++;
				const assistant = msg as AssistantMessage;
				metrics.recordAssistant(turnNumber, assistant);
				const cache = assistant.usage ? assistant.usage.cacheRead : null;
				metrics.recordCache(cache ?? null, provider.cacheSignalPresent);
			}
		} else if (event.type === "compaction_start" || event.type === "session_compact") {
			metrics.noteNativeCompaction();
		}
	});

	await session.bindExtensions({});
	await session.prompt(scenario.prompt);
	await session.agent.waitForIdle();

	// Fold in the native summariser's own token cost (arm B). Zero for A/C/D.
	const summ = provider.getSummarizerTokens();
	metrics.recordSummarizer(summ.calls, summ.inputTokens, summ.outputTokens);

	const sessionFile = sessionManager.getSessionFile();
	const sessionId = sessionFile ? sessionFile.split("/").pop()!.replace(/\.jsonl$/, "") : "";

	// Assemble the JSONL rows.
	const meta: MetaRow = {
		type: "meta",
		schema_version: SCHEMA_VERSION,
		arm: arm.id,
		arm_label: arm.label,
		scenario: scenario.id,
		provider: args.provider,
		mechanism: {
			native_compaction_enabled: arm.nativeCompactionEnabled,
			seam_a_installed: arm.seamAInstalled,
			seam_b_installed: seamBInstalled,
			compact_after_input_tokens: arm.seamAInstalled ? args.compactAfter : null,
			keep_recent_assistant_messages: arm.seamAInstalled ? args.keepRecent : null,
		},
		started_at: new Date().toISOString(),
		data_kind: "synthetic-smoke-fixture",
	};
	const summary = metrics.buildSummary({
		arm: arm.id,
		arm_label: arm.label,
		scenario: scenario.id,
		provider: args.provider,
		session_id: sessionId,
		workspace: tempDir,
	});
	const rows: MetricRow[] = [meta, ...metrics.getTurns(), summary];

	// Write output. Default path under results/ if --out omitted.
	const outPath = resolveOut(args.out, arm.id, scenario.id);
	mkdirSync(dirname(outPath), { recursive: true });
	const body =
		`# ecode experiments run — arm ${arm.id} (${arm.label}) — scenario ${scenario.id}\n` +
		`# provider=${args.provider} compact-after=${args.compactAfter} keep-recent=${args.keepRecent} seam-b=${seamBInstalled}\n` +
		`# SYNTHETIC SMOKE FIXTURE — not a real experimental workload\n` +
		rows.map((r) => JSON.stringify(r)).join("\n") +
		"\n";
	writeFileSync(outPath, body, "utf-8");

	// eslint-disable-next-line no-console
	console.log(
		`arm ${arm.id}: ${provider.getCallCount()} provider calls, ${metrics.getTurns().length} turns, ` +
			`projected=${summary.projected_turn_count}, native=${summary.native_compactions_observed}, ` +
			`re_reads=${summary.total_re_reads}, compacted_path_re_reads=${summary.total_compacted_path_re_reads} -> ${outPath}`,
	);

	session.dispose();
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
}

function resolveOut(out: string | undefined, armId: string, scenarioId: string): string {
	if (out) return isAbsolute(out) ? out : resolvePath(process.cwd(), out);
	return resolvePath(process.cwd(), "results", `${scenarioId}-${armId}.jsonl`);
}

run(parseArgs(process.argv.slice(2))).catch((e) => {
	// eslint-disable-next-line no-console
	console.error(e instanceof Error ? e.stack ?? e.message : String(e));
	process.exit(1);
});

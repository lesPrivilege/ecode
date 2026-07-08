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

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
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
	type TailEvidence,
	type TaxProbeTurn,
} from "./lib/compaction-core-adapter.js";
import { resolveArmSpec, DEFAULT_COMPACT_AFTER_INPUT_TOKENS, DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES } from "./lib/arms.js";
import { getScenario } from "./fixtures/index.js";
import { isPacketSpec, loadPacket, type AcceptanceCheck, type FileExistsCheck, type PacketScenario } from "./lib/packet.js";
import type { Scenario } from "./lib/scenario.js";
import { runAcceptance, type AcceptanceRow } from "./lib/acceptance.js";
import { exportRunArtifacts, type ArtifactManifest } from "./lib/artifacts.js";
import { copyWorkspaceFrom } from "./lib/workspace.js";
import { createSidebandSummarizer, resolveProvider, DEFAULT_PROVIDER } from "./lib/provider.js";
import { RunMetrics, type MetaRow, type MetricRow, type TurnRow } from "./lib/metrics.js";
// G4c — TRC (frontier-pruning) arm T. Relative source-path import, not
// package-name resolution (repo-wide discipline for pi-adjacent extensions —
// see extensions/frontier-pruning/src/context-pruning.ts). `projectContext`
// is aliased: this file already imports DC's OWN `projectContext` above from
// compaction-core-adapter.js, and the two are unrelated pure functions with
// the same name.
import { default as frontierPruningExtension } from "../extensions/frontier-pruning/src/extension.js";
import { projectContext as projectTrcContext } from "../extensions/frontier-pruning/src/projection.js";
import { estimateTokensCharsDiv4 } from "../extensions/frontier-pruning/src/estimator.js";
import { parseTrcFlags, type EnvLike } from "../extensions/frontier-pruning/src/flags.js";

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
	/**
	 * G1d: seed the run's working dir from a prepared snapshot (built once by
	 * prepare-snapshot.ts) instead of a fresh empty tmpdir. When set, the snapshot's
	 * `workspace/` is copied in and its {source, manifestHash} recorded in the JSONL.
	 * Unset → unchanged legacy behaviour (empty tmpdir + scenario.seedFiles).
	 */
	workspaceFrom?: string;
	/** Override the packets doc a `packet:`/`G2-…` scenario is loaded from. */
	packetsDoc?: string;
	/** Override provider model context window; used by B-fixed preflight. */
	contextWindow?: number;
	/**
	 * G4c — arm T (TRC) tuning. Meaningful only when `--arm T`; translated into
	 * the ECODE_TRC_* env-var shape frontier-pruning's own (unmodified)
	 * parseTrcFlags already reads, so the extension's flags surface is reused
	 * verbatim rather than re-implemented here. All optional and OMITTED
	 * (not defaulted here) when unset, so parseTrcFlags's own defaults apply
	 * — a single source of truth for TRC's default trigger/keep/etc, not
	 * duplicated magic numbers.
	 */
	trcTriggerTokens?: number;
	trcKeep?: number;
	trcClearAtLeast?: number;
	trcExcludeTools?: string;
	trcClearToolInputs?: string;
	trcPreserveErrors: boolean;
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
	const asOptNum = (v: string | boolean | undefined): number | undefined =>
		typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : undefined;
	const asOptStr = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);
	return {
		arm: typeof flags.arm === "string" ? flags.arm : "C",
		scenario: typeof flags.scenario === "string" ? flags.scenario : "refactor",
		out: typeof flags.out === "string" ? flags.out : undefined,
		provider: typeof flags.provider === "string" ? flags.provider : DEFAULT_PROVIDER,
		compactAfter: asNum(flags["compact-after"], DEFAULT_COMPACT_AFTER_INPUT_TOKENS),
		keepRecent: asNum(flags["keep-recent"] ?? flags["keep-recent-assistant-messages"], DEFAULT_KEEP_RECENT_ASSISTANT_MESSAGES),
		// --seam-b forces seam B on regardless of arm default (arm D sets it anyway).
		seamB: flags["seam-b"] === true || flags["seam-b"] === "true",
		workspaceFrom: typeof flags["workspace-from"] === "string" ? flags["workspace-from"] : undefined,
		packetsDoc: typeof flags["packets-doc"] === "string" ? flags["packets-doc"] : undefined,
		contextWindow: asNum(flags["context-window"], Number.NaN),
		// G4c — arm T tuning; each omitted unless explicitly passed (see Args doc).
		trcTriggerTokens: asOptNum(flags["trc-trigger-tokens"]),
		trcKeep: asOptNum(flags["trc-keep"]),
		trcClearAtLeast: asOptNum(flags["trc-clear-at-least"]),
		trcExcludeTools: asOptStr(flags["trc-exclude-tools"]),
		trcClearToolInputs: asOptStr(flags["trc-clear-tool-inputs"]),
		trcPreserveErrors: flags["trc-preserve-errors"] === true || flags["trc-preserve-errors"] === "true",
	};
}

function envBool(name: string): boolean {
	const raw = (process.env[name] ?? "").trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

// --- scenario resolution: fixture id OR packet spec -----------------------------

// Repo root anchored to run.ts's own location (experiments/run.ts -> repo root is
// one level up), so packet/doc paths resolve regardless of the invoking cwd.
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolve a `--scenario` value to a Scenario. A fixture id (e.g. "refactor") comes
 * from the hardcoded registry; a packet spec ("G2-R2", "packet:G2-R2", or a `.md`
 * path) is parsed from the G2 packets doc via lib/packet.ts. Packet scenarios carry
 * their acceptance checks; fixture scenarios do not.
 */
function resolveScenario(spec: string, packetsDoc: string | undefined): Scenario | PacketScenario {
	if (isPacketSpec(spec)) {
		return loadPacket(spec, { repoRoot: REPO_ROOT, doc: packetsDoc });
	}
	return getScenario(spec);
}

function isPacketScenario(s: Scenario | PacketScenario): s is PacketScenario {
	return Array.isArray((s as PacketScenario).acceptance);
}

function isFileExistsCheck(check: AcceptanceCheck): check is FileExistsCheck {
	return check.kind === "file-exists";
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

// --- extract cleared read paths from a TRC projection outcome (G4c) -------

/**
 * Which `read` result paths did TRC clear this turn? Unlike DC's compaction,
 * clearToolUses stamps no meta marker on what it touches (see
 * extensions/frontier-pruning/src/projection.ts's header — that's exactly
 * why this extension writes its own new inverse-mapper instead of reusing
 * DC's adapter fromCore). Detection here uses the SAME identity-preservation
 * contract that mapper relies on: an untouched pi AgentMessage comes back as
 * the exact same object reference, so `before[i] !== after[i]` is a
 * complete, marker-free "this changed" test at the pi message level too.
 *
 * `pathAlive=false` marks a pair whose `clearToolInputs` ALSO wiped the
 * paired toolCall's `path` argument (arguments became `{}`) — the path's
 * identity, not just its content, is no longer observable in the outgoing
 * transcript. Callers should exclude those from the re-read-tracking set:
 * conflating "content cleared, path still visible" with "path itself gone"
 * would corrupt the compacted-path isomorphism cleared_path_re_reads mirrors.
 */
interface ClearedPathEntry {
	toolCallId: string;
	path: string | undefined;
	pathAlive: boolean;
}

function clearedReadPaths(before: AgentMessage[], after: AgentMessage[]): ClearedPathEntry[] {
	const callInfoById = new Map<string, { path: string | undefined; ownerIndex: number }>();
	before.forEach((m, idx) => {
		if (m.role !== "assistant") return;
		for (const block of (m as AssistantMessage).content) {
			if (block.type !== "toolCall" || block.name !== "read") continue;
			const path = typeof block.arguments?.path === "string" ? (block.arguments.path as string) : undefined;
			callInfoById.set(block.id, { path, ownerIndex: idx });
		}
	});

	const entries: ClearedPathEntry[] = [];
	for (let i = 0; i < before.length; i++) {
		const b = before[i];
		const a = after[i];
		if (!b || !a || b === a) continue;
		if (b.role !== "toolResult") continue;
		const toolCallId = (b as { toolCallId?: string }).toolCallId;
		if (!toolCallId) continue;
		const info = callInfoById.get(toolCallId);
		if (!info) continue; // not a paired "read" call (other tool, or orphan) — not tracked

		let pathAlive = true;
		const ownerBefore = before[info.ownerIndex] as AssistantMessage | undefined;
		const ownerAfter = after[info.ownerIndex] as AssistantMessage | undefined;
		if (ownerBefore && ownerAfter && ownerBefore !== ownerAfter) {
			const afterCall = ownerAfter.content.find((c) => c.type === "toolCall" && c.id === toolCallId);
			if (afterCall && afterCall.type === "toolCall" && Object.keys(afterCall.arguments ?? {}).length === 0) {
				pathAlive = false;
			}
		}
		entries.push({ toolCallId, path: info.path, pathAlive });
	}
	return entries;
}

// --- the run --------------------------------------------------------------

async function run(args: Args): Promise<void> {
	const armSpec = resolveArmSpec(args.arm);
	const arm = armSpec.base;
	const scenario = resolveScenario(args.scenario, args.packetsDoc);
	const packetScenario = isPacketScenario(scenario) ? scenario : null;
	const extensionFlags = {
		semanticAnchor: armSpec.flags.semanticAnchor || envBool("ECODE_SEMANTIC_ANCHOR"),
		workSemanticsDeclaration: armSpec.flags.workSemanticsDeclaration || envBool("ECODE_WS_DECLARATION"),
		sidebandSummary: armSpec.flags.sidebandSummary || envBool("ECODE_SIDEBAND_SUMMARY"),
		workSemanticsPolicy: armSpec.flags.workSemanticsPolicy || envBool("ECODE_WS_POLICY"),
		placeboTokenMatching: armSpec.flags.placeboTokenMatching || envBool("ECODE_WS_PLACEBO"),
		compactNudgeTail: armSpec.flags.compactNudgeTail || envBool("ECODE_WS_NUDGE"),
	};
	const declareNudge = (process.env.ECODE_WS_DECLARE_NUDGE ?? "").trim().toLowerCase() === "every-turn" ? "every-turn" : "off";
	const anchorAcceptBefore = process.env.ECODE_ANCHOR_ACCEPTANCE;
	if (packetScenario && extensionFlags.semanticAnchor) {
		const targets = packetScenario.acceptance
			.filter(isFileExistsCheck)
			.map((check) => check.path)
			.filter(Boolean);
		if (targets.length > 0) process.env.ECODE_ANCHOR_ACCEPTANCE = targets.join(",");
	}
	const provider = resolveProvider(args.provider, scenario, {
		...(Number.isFinite(args.contextWindow) ? { contextWindow: args.contextWindow } : {}),
	});

	// seam B: arm default OR explicit --seam-b.
	const seamBInstalled = arm.seamBInstalled || args.seamB;
	// seam A config (only meaningful when seamAInstalled).
	const projectionConfig: ProjectionConfig = {
		compactAfterInputTokens: args.compactAfter,
		compactionOptions: { keepRecentAssistantMessages: args.keepRecent },
	};

	// G4c — TRC (arm T) config, only meaningful when arm.trcInstalled. CLI
	// --trc-* flags translate into the ECODE_TRC_* env-var shape
	// frontier-pruning's own parseTrcFlags reads (single source of truth for
	// TRC's defaults — see Args doc); ECODE_TRC is forced "1" so selecting
	// `--arm T` alone is sufficient, mirroring how other arms don't need a
	// redundant separate switch. Real process.env is the base so any
	// ECODE_TRC_* var already exported by the caller still passes through.
	const trcEnv: EnvLike | undefined = arm.trcInstalled
		? {
				...process.env,
				ECODE_TRC: "1",
				...(args.trcTriggerTokens !== undefined ? { ECODE_TRC_TRIGGER_TOKENS: String(args.trcTriggerTokens) } : {}),
				...(args.trcKeep !== undefined ? { ECODE_TRC_KEEP: String(args.trcKeep) } : {}),
				...(args.trcClearAtLeast !== undefined ? { ECODE_TRC_CLEAR_AT_LEAST: String(args.trcClearAtLeast) } : {}),
				...(args.trcExcludeTools !== undefined ? { ECODE_TRC_EXCLUDE_TOOLS: args.trcExcludeTools } : {}),
				...(args.trcClearToolInputs !== undefined ? { ECODE_TRC_CLEAR_TOOL_INPUTS: args.trcClearToolInputs } : {}),
				ECODE_TRC_PRESERVE_ERRORS: args.trcPreserveErrors ? "1" : "0",
			}
		: undefined;
	const trcFlags = trcEnv ? parseTrcFlags(trcEnv) : null;

	// Working directory. Two mutually-exclusive construction paths:
	//   (default) fresh empty tmpdir, then write scenario.seedFiles into it — the
	//             legacy path, unchanged for the mock fixtures.
	//   (--workspace-from) copy a prepared snapshot's workspace/ in (cheap, per-run),
	//             recording {source, manifestHash} for provenance. run.ts does ONLY
	//             this cheap copy; building the snapshot is prepare-snapshot.ts's job.
	const tempDir = join(tmpdir(), `pi-ecode-run-${safeName(armSpec.id)}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	let workspaceProvenance: { source: string; manifestHash: string | null } | undefined;
	if (args.workspaceFrom) {
		const copied = copyWorkspaceFrom(args.workspaceFrom, tempDir);
		workspaceProvenance = { source: copied.source, manifestHash: copied.manifestHash };
	} else {
		mkdirSync(tempDir, { recursive: true });
		// seed files if the scenario needs pre-existing content.
		for (const [rel, content] of Object.entries(scenario.seedFiles ?? {})) {
			const p = join(tempDir, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, content, "utf-8");
		}
	}
	// The agent dir is a SIBLING of the workspace, never inside it — so a snapshot
	// copy stays a faithful copy and the acceptance-checked workspace is not
	// polluted by pi's per-run agent state. (For the legacy empty-tmpdir path this
	// is behaviourally identical: the fixture never reads pi's agent dir.)
	const agentDir = `${tempDir}-agent`;
	mkdirSync(agentDir, { recursive: true });

	const metrics = new RunMetrics();
	const plannedOutPath = resolveOut(args.out, armSpec.id, scenario.id);
	const taxProbeWrite = (row: TaxProbeTurn): string => appendExperimentTaxProbeRow(row, plannedOutPath);
	const recordTailEvidence = (evidence: TailEvidence): void => metrics.noteTailEvidence(evidence);
	const pendingSidebandTasks: Promise<void>[] = [];
	const sidebandSummarizer = extensionFlags.sidebandSummary ? createSidebandSummarizer(provider) : undefined;

	// Extension factory: register provider, install the arm's real hook(s), and
	// ALWAYS install the observer hook (records metrics; never mutates payload).
	const factory = (pi: ExtensionAPI) => {
		// Only register providers pi does not ship natively. The mock and the generic
		// openai-compat provider need registration (register: true); DeepSeek is a
		// pi built-in (register: false) and registering it would REPLACE its built-in
		// models, so we leave the stock ModelRegistry to resolve deepseek/* directly.
		if (provider.register) {
			pi.registerProvider(provider.providerName, provider.config);
		}

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
			} else if (arm.trcInstalled && trcFlags) {
				// G4c — same re-derivation discipline as the seam-A branch above, but
				// through frontier-pruning's own (unmodified) projectContext/estimator
				// (R3: TRC's gate reads its OWN injected chars/4 estimator, never pi's
				// estimateContextTokens or any provider usage field). `trc` is
				// populated EVERY turn TRC is installed, applied or not, so the field
				// is never half-null (see TurnRow.trc doc in metrics.ts).
				const trcOutcome = projectTrcContext(messages, trcFlags.config, { estimateTokens: estimateTokensCharsDiv4 });
				metrics.onOutgoingTokens(estimatePayloadTokens(trcOutcome.messages));
				const cleared = clearedReadPaths(messages, trcOutcome.messages);
				const aliveClearedPaths = cleared.filter((e) => e.pathAlive && e.path !== undefined).map((e) => e.path!);
				metrics.noteTrc(
					{
						applied: trcOutcome.applied,
						clearedToolUses: trcOutcome.report.clearedToolUses,
						clearedInputTokensEst: trcOutcome.report.clearedInputTokens,
						gateReading: trcOutcome.report.gateReading,
					},
					aliveClearedPaths,
				);
			} else {
				// No hook: the raw payload is what gets sent.
				metrics.onOutgoingTokens(estimatePayloadTokens(messages));
			}
			return undefined; // observer never changes the payload
		});

		if (arm.trcInstalled && trcEnv) {
			// The REAL hook: registered after the observer (same ordering discipline
			// as seam-A below), actually performs the clearing that reaches the
			// provider. frontier-pruning's own factory — zero copy, zero modification.
			frontierPruningExtension(pi, trcEnv);
		}

		if (arm.seamAInstalled) {
			installDeterministicCompaction(pi, {
				compactAfterInputTokens: args.compactAfter,
				compactionOptions: { keepRecentAssistantMessages: args.keepRecent },
				seamBEnabled: seamBInstalled,
				semanticAnchorEnabled: extensionFlags.semanticAnchor,
				workSemanticsDeclarationEnabled: extensionFlags.workSemanticsDeclaration,
				sidebandSummaryEnabled: extensionFlags.sidebandSummary,
				workSemanticsPolicyEnabled: extensionFlags.workSemanticsPolicy,
				placeboTailEnabled: extensionFlags.placeboTokenMatching,
				compactNudgeTailEnabled: extensionFlags.compactNudgeTail,
				workSemanticsDeclareNudge: declareNudge,
			}, {
				sideband: {
					summarize: sidebandSummarizer,
					onSummary: (record) => metrics.recordSideband(record),
					onTask: (task) => pendingSidebandTasks.push(task),
				},
				taxProbe: {
					write: (row) => taxProbeWrite(row),
				},
				tailEvidence: {
					record: recordTailEvidence,
				},
			});
		}
	};

	const settingsManager = SettingsManager.create(tempDir, agentDir);
	// ARM A's disable + arms C/D isolation: flip the exact flag _checkCompaction reads.
	settingsManager.setCompactionEnabled(arm.nativeCompactionEnabled);

	const sessionManager = SessionManager.create(tempDir);
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	// Inject a runtime key ONLY when the provider asks for one (the mock's non-secret
	// "mock-key"). Real providers leave provider.runtimeApiKey undefined: DeepSeek
	// resolves DEEPSEEK_API_KEY through pi's native auth and the openai-compat branch
	// resolves its key from the configured "$ENV_VAR" — injecting here would SHADOW
	// the real key. No real key material ever flows through this call.
	if (provider.runtimeApiKey !== undefined) {
		authStorage.setRuntimeApiKey(provider.providerName, provider.runtimeApiKey);
	}
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
	if (pendingSidebandTasks.length > 0) {
		await Promise.allSettled(pendingSidebandTasks);
	}

	// Fold in the native summariser's own token cost (arm B). Zero for A/C/D.
	const summ = provider.getSummarizerTokens();
	metrics.recordSummarizer(summ.calls, summ.inputTokens, summ.outputTokens);

	const sessionFile = sessionManager.getSessionFile();
	const sessionId = sessionFile ? sessionFile.split("/").pop()!.replace(/\.jsonl$/, "") : "";

	// data_kind reflects the workload: a packet run seeded from a real snapshot is
	// NOT a synthetic smoke fixture. A mock-provider packet run against a snapshot
	// is a "mock-packet-smoke". The bare fixture path keeps its original marker.
	const dataKind = packetScenario
		? args.provider === "mock"
			? "mock-packet-smoke"
			: "g2-packet-run"
		: "synthetic-smoke-fixture";

	// Assemble the JSONL rows.
	const meta: MetaRow = {
		type: "meta",
		schema_version: SCHEMA_VERSION,
		arm: armSpec.id,
		arm_label: armSpec.label,
		scenario: scenario.id,
		provider: args.provider,
		mechanism: {
			native_compaction_enabled: arm.nativeCompactionEnabled,
			seam_a_installed: arm.seamAInstalled,
			seam_b_installed: seamBInstalled,
			compact_after_input_tokens: arm.seamAInstalled ? args.compactAfter : null,
			keep_recent_assistant_messages: arm.seamAInstalled ? args.keepRecent : null,
			provider_context_window: Number.isFinite(args.contextWindow) ? args.contextWindow : null,
			anchor_acceptance_targets: process.env.ECODE_ANCHOR_ACCEPTANCE ?? null,
			extension_flags: {
				semantic_anchor: extensionFlags.semanticAnchor,
				ws_declaration: extensionFlags.workSemanticsDeclaration,
				sideband_summary: extensionFlags.sidebandSummary,
				ws_policy: extensionFlags.workSemanticsPolicy,
				placebo_token_matching: extensionFlags.placeboTokenMatching,
				compact_nudge_tail: extensionFlags.compactNudgeTail,
			},
			placebo_tail_target_tokens: extensionFlags.placeboTokenMatching ? 120 : null,
			ws_declare_nudge: declareNudge,
			trc_installed: arm.trcInstalled === true,
			trc_config: trcFlags
				? {
						trigger_tokens: trcFlags.config.trigger.value,
						keep: trcFlags.config.keep.value,
						clear_at_least: trcFlags.config.clearAtLeast?.value ?? null,
						exclude_tools: trcFlags.config.excludeTools ?? null,
						clear_tool_inputs: trcFlags.config.clearToolInputs ?? false,
						preserve_error_results: trcFlags.config.preserveErrorResults ?? false,
					}
				: null,
		},
		started_at: new Date().toISOString(),
		data_kind: dataKind,
		...(workspaceProvenance ? { workspace: workspaceProvenance } : {}),
	};
	const summary = metrics.buildSummary({
		arm: armSpec.id,
		arm_label: armSpec.label,
		scenario: scenario.id,
		provider: args.provider,
		session_id: sessionId,
		workspace: tempDir,
		data_kind: dataKind,
	});

	// Acceptance: for a packet run, evaluate its STATIC checks against the FINAL
	// workspace now (before cleanup) and append the machine-readable results as a
	// dedicated `accept` row. command:-kind checks are recorded pending, never run.
	let acceptRow: AcceptanceRow | undefined;
	if (packetScenario) {
		acceptRow = runAcceptance(packetScenario.acceptance, packetScenario.metadata.id, tempDir);
	}

	// Write output. Default path under results/ if --out omitted.
	const outPath = plannedOutPath;
	mkdirSync(dirname(outPath), { recursive: true });

	const artifactRow: ArtifactManifest = exportRunArtifacts({
		workspace: tempDir,
		outPath,
		packet: packetScenario?.metadata ?? null,
		acceptance: packetScenario?.acceptance ?? [],
		workspaceFrom: args.workspaceFrom,
	});

	const rows: (MetricRow | AcceptanceRow | ArtifactManifest)[] = [
		meta,
		...metrics.getTurns(),
		...metrics.getSidebandRows(),
		summary,
		...(acceptRow ? [acceptRow] : []),
		artifactRow,
	];

	const header = packetScenario
		? `# ecode experiments run — arm ${armSpec.id} (${armSpec.label}) — packet ${packetScenario.metadata.id}\n` +
			`# provider=${args.provider} compact-after=${args.compactAfter} keep-recent=${args.keepRecent} seam-b=${seamBInstalled}\n` +
			`# data_kind=${dataKind}${workspaceProvenance ? ` workspace-from=${workspaceProvenance.source}` : ""}\n`
		: `# ecode experiments run — arm ${armSpec.id} (${armSpec.label}) — scenario ${scenario.id}\n` +
			`# provider=${args.provider} compact-after=${args.compactAfter} keep-recent=${args.keepRecent} seam-b=${seamBInstalled}\n` +
			`# SYNTHETIC SMOKE FIXTURE — not a real experimental workload\n`;
	const body = header + rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
	writeFileSync(outPath, body, "utf-8");

	// eslint-disable-next-line no-console
	console.log(
		`arm ${armSpec.id}: ${provider.getCallCount()} provider calls, ${metrics.getTurns().length} turns, ` +
			`projected=${summary.projected_turn_count}, native=${summary.native_compactions_observed}, ` +
			`re_reads=${summary.total_re_reads}, compacted_path_re_reads=${summary.total_compacted_path_re_reads}` +
			(acceptRow ? `, accept=${acceptRow.static_passed}/${acceptRow.static_total} static (${acceptRow.pending_total} pending)` : "") +
			` -> ${outPath}`,
	);

	session.dispose();
	if (anchorAcceptBefore === undefined) delete process.env.ECODE_ANCHOR_ACCEPTANCE;
	else process.env.ECODE_ANCHOR_ACCEPTANCE = anchorAcceptBefore;
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
}

function resolveOut(out: string | undefined, armId: string, scenarioId: string): string {
	if (out) return isAbsolute(out) ? out : resolvePath(process.cwd(), out);
	// Sanitise scenario id for the filename (packet ids like "G2-R2" are fine; a
	// stray path/space would not be).
	const safe = scenarioId.replace(/[^A-Za-z0-9._-]/g, "_");
	return resolvePath(process.cwd(), "results", `${safe}-${safeName(armId)}.jsonl`);
}

function safeName(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function appendExperimentTaxProbeRow(row: TaxProbeTurn, outPath: string): string {
	const dir = join(dirname(outPath), ".ws-tax-probe");
	mkdirSync(dir, { recursive: true });
	const stem = basename(outPath).replace(/\.jsonl$/, "");
	const file = join(dir, `${stem}.jsonl`);
	appendFileSync(file, `${JSON.stringify(row)}\n`, "utf-8");
	return file;
}

run(parseArgs(process.argv.slice(2))).catch((e) => {
	// eslint-disable-next-line no-console
	console.error(e instanceof Error ? e.stack ?? e.message : String(e));
	process.exit(1);
});

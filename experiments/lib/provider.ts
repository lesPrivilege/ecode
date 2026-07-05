/**
 * Pluggable provider abstraction — the seam that makes swapping the mock provider
 * for a real DeepSeek/Mimo provider (G2) a CONFIG change, not a code change.
 *
 * run.ts never constructs a provider directly; it asks `resolveProvider(name,
 * scenario, opts)` for an ExperimentProvider and wires whatever comes back. The
 * mock implementation replays the scenario's scripted steps through G1b's
 * createMockProvider (no network, no key). A future real provider is added here
 * as another case that returns a `ProviderConfig` built from real credentials
 * resolved out-of-band (env / auth.json) — the run/metrics/gate code is untouched.
 *
 * SUMMARIZATION AWARENESS (for arm B): pi's native auto-compaction issues an
 * EXTRA provider call for the summary, tagged with SUMMARIZATION_SYSTEM_PROMPT.
 * G1b's mock replays steps by call-count and would mis-serve (or exhaust) that
 * call. So the mock's streamSimple is WRAPPED here (G1b's mock stays untouched):
 * a summarization request returns a canned deterministic summary WITHOUT
 * consuming a scenario step, and its input/output tokens are surfaced via
 * `getSummarizerTokens()` so run.ts can add the summariser's own cost to arm B —
 * exactly the "account for the summariser's tokens" requirement.
 */

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context, type Model, type Usage } from "@earendil-works/pi-ai";
import { createMockProvider } from "./compaction-core-adapter.js";
import type { Scenario } from "./scenario.js";

/**
 * Stable marker present in pi's compaction system prompt
 * (agent/.../compaction.ts SUMMARIZATION_SYSTEM_PROMPT). That constant is not
 * exported from pi's public index, so we detect a summarisation call by this
 * substring rather than importing the exact prompt.
 */
const SUMMARIZATION_PROMPT_MARKER = "context summarization assistant";

export interface SummarizerTokens {
	/** Number of summariser calls served. */
	calls: number;
	/** Estimated input tokens fed to the summariser across all its calls. */
	inputTokens: number;
	/** Output tokens the summariser produced across all its calls. */
	outputTokens: number;
}

export interface ExperimentProvider {
	providerName: string;
	config: ProviderConfig;
	model: Model<string>;
	modelRef: string;
	getCallCount(): number;
	/** Summariser-call accounting (arm B). Zero when no summary call was served. */
	getSummarizerTokens(): SummarizerTokens;
	/**
	 * Whether responses from this provider carry a genuine cache-read signal.
	 * false for the mock (so cacheRead is recorded as null, not 0). A real
	 * DeepSeek provider sets this true and the run records usage.cacheRead.
	 */
	cacheSignalPresent: boolean;
}

const MOCK_PROVIDER = "mockcompact";
const MOCK_API = "mockcompact-api";
const MOCK_MODEL_ID = "mock-1";

/** Default mock context window. Deliberately modest so pi's native auto-compaction
 *  (fires above contextWindow - reserveTokens, reserve default 16384) is reachable
 *  by the smoke fixture for arm B. Seam-A arms disable native compaction, so the
 *  window does not gate them. */
const DEFAULT_MOCK_CONTEXT_WINDOW = 48000;

export interface ProviderOptions {
	/** Override the mock model's context window (arm B native-trigger tuning). */
	contextWindow?: number;
}

function buildMockModel(contextWindow: number): Model<string> {
	return {
		id: MOCK_MODEL_ID,
		name: "Mock Compaction Model",
		api: MOCK_API,
		provider: MOCK_PROVIDER,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	} as Model<string>;
}

/** Rough char->token estimate for the summariser's input payload. */
function estimateContextChars(context: Context): number {
	let chars = (context.systemPrompt ?? "").length;
	for (const m of context.messages ?? []) {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") chars += content.length;
		else if (Array.isArray(content)) {
			for (const b of content as { type?: string; text?: string }[]) {
				if (b.type === "text" && b.text) chars += b.text.length;
			}
		}
	}
	return chars;
}

function mockProvider(scenario: Scenario, opts: ProviderOptions): ExperimentProvider {
	const contextWindow = opts.contextWindow ?? DEFAULT_MOCK_CONTEXT_WINDOW;
	const handle = createMockProvider({
		providerName: MOCK_PROVIDER,
		api: MOCK_API,
		modelId: MOCK_MODEL_ID,
		steps: scenario.steps,
		contextWindow,
	});

	const summarizer: SummarizerTokens = { calls: 0, inputTokens: 0, outputTokens: 0 };
	const CANNED_SUMMARY =
		"## Goal\nDeterministic smoke summary (mock).\n\n## Progress\n### Done\n- earlier turns summarised by the native compactor\n\n## Next Steps\n1. continue\n";
	const summaryOutputTokens = Math.ceil(CANNED_SUMMARY.length / 4);

	// Wrap streamSimple: intercept summarization calls; delegate the rest to G1b's
	// mock (which serves scenario steps by call-count).
	const underlying = handle.config.streamSimple!;
	handle.config.streamSimple = (model, context, options) => {
		if ((context.systemPrompt ?? "").includes(SUMMARIZATION_PROMPT_MARKER)) {
			summarizer.calls++;
			summarizer.inputTokens += Math.ceil(estimateContextChars(context) / 4);
			summarizer.outputTokens += summaryOutputTokens;
			// Build a minimal assistant stream carrying the canned summary. We reuse
			// pi-ai's stream primitives via a tiny inline provider call is overkill;
			// instead we synthesize the same shape G1b's mock uses.
			return synthSummaryStream(model, CANNED_SUMMARY, summaryOutputTokens);
		}
		return underlying(model, context, options);
	};

	return {
		providerName: MOCK_PROVIDER,
		config: handle.config,
		model: buildMockModel(contextWindow),
		modelRef: handle.modelRef,
		getCallCount: handle.getCallCount,
		getSummarizerTokens: () => ({ ...summarizer }),
		cacheSignalPresent: false, // mock emits no real cache signal -> null metric
	};
}

// A standalone assistant stream for the canned summary (kept local so G1b's mock
// is untouched). Imported lazily to avoid a hard dep at module top.
function synthSummaryStream(model: Model<string>, text: string, outputTokens: number) {
	const stream = createAssistantMessageEventStream();
	const usage: Usage = {
		input: 0,
		output: outputTokens,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: outputTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const message = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

/**
 * Resolve a provider by name. Only "mock" exists today; adding "deepseek" etc.
 * here (returning a real ProviderConfig) is the entire G2 provider swap.
 */
export function resolveProvider(name: string, scenario: Scenario, opts: ProviderOptions = {}): ExperimentProvider {
	switch (name) {
		case "mock":
			return mockProvider(scenario, opts);
		default:
			throw new Error(
				`Unknown provider "${name}". Known: mock. (Real providers are added in lib/provider.ts as a config swap; see G2.)`,
			);
	}
}

export const DEFAULT_PROVIDER = "mock";

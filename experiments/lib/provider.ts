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
// Built-in model catalog read. `getModels("deepseek")` returns pi's NATIVE
// DeepSeek models (deepseek-v4-flash / -pro, api "openai-completions"), so the
// deepseek branch reuses exactly what pi ships rather than reconstructing a
// ProviderConfig. Imported from the "/compat" subpath because that is the entry
// the experiment's module resolver (lib/loader.mjs) and vitest both alias — the
// non-deprecated "/providers/all" subpath is intentionally NOT aliased there.
import { getModels } from "@earendil-works/pi-ai/compat";
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
	/**
	 * Whether run.ts must call `pi.registerProvider(providerName, config)` to make
	 * this provider's model resolvable.
	 *
	 * true  — the mock (pi has no built-in "mock" provider) and the generic
	 *         openai-compat provider (pi does not ship it natively): the config
	 *         must be registered.
	 * false — DeepSeek: pi ships it as a BUILT-IN provider, so its models and
	 *         env-based auth (DEEPSEEK_API_KEY) already resolve through the stock
	 *         ModelRegistry with zero registration. Registering it would REPLACE
	 *         the built-in models (types.ts registerProvider: "If models is
	 *         provided: replaces all existing models"), so we deliberately do not.
	 */
	register: boolean;
	/**
	 * Literal API key run.ts should inject via `authStorage.setRuntimeApiKey`, or
	 * undefined to inject nothing.
	 *
	 * The mock sets "mock-key" (a non-secret literal its scripted streamSimple
	 * ignores) so auth resolution never blocks the no-network smoke path. Real
	 * providers leave this undefined: DeepSeek resolves its key from the
	 * DEEPSEEK_API_KEY env var through pi's native auth, and the openai-compat
	 * branch resolves its key from the configured env var via the "$ENV_VAR"
	 * interpolation in `config.apiKey` — injecting a runtime key would SHADOW the
	 * real one. No real key ever passes through this field.
	 */
	runtimeApiKey?: string;
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
	/** Configuration for the "openai-compat" provider (baseUrl / modelId / apiKeyEnv). */
	openAICompat?: OpenAICompatOptions;
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
		// Scenario.steps is optional (packet-loaded scenarios have none — a real
		// model chooses its own actions). The mock is the ONLY consumer of steps;
		// a missing script becomes an empty one (the mock then stops immediately
		// with "no more scripted steps"), which is exactly right for the mock
		// smoke path against a packet — the workspace/accept plumbing is what that
		// path exercises, not model behaviour.
		steps: scenario.steps ?? [],
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
		register: true, // pi has no built-in "mock" provider; the config must be registered
		runtimeApiKey: "mock-key", // non-secret literal; the scripted streamSimple ignores it
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

/** Zero summariser accounting for real providers. The mock's canned-summary
 *  interception (and its token attribution) is mock-specific; a real provider's
 *  own summariser cost, when arm B runs it, surfaces through actual assistant
 *  usage on the metrics path, not through this scripted hook. */
const NO_SUMMARIZER: SummarizerTokens = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** The default DeepSeek model the experiment drives. A real, current built-in id. */
const DEEPSEEK_MODEL_ID = "deepseek-v4-flash";
const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

/**
 * DeepSeek via pi's NATIVE, built-in provider. No ProviderConfig is constructed
 * and no `pi.registerProvider` is issued: pi already ships the "deepseek"
 * provider (its models come from getModels("deepseek"); its auth resolves
 * DEEPSEEK_API_KEY from the environment via the stock AuthStorage/ModelRegistry,
 * verified empirically). run.ts therefore leaves this provider unregistered
 * (`register: false`) and injects no runtime key (`runtimeApiKey` undefined) so
 * the real env key is used and never shadowed.
 *
 * Fail-fast: the key can only be resolved out-of-band from DEEPSEEK_API_KEY, so
 * when that variable is absent we raise a specific, actionable error HERE —
 * before any session is built and long before any network path — rather than
 * letting resolution fail deep inside a stream attempt. Only the variable NAME
 * is named; no key value is ever read, logged, or embedded.
 */
function deepseekProvider(opts: ProviderOptions = {}): ExperimentProvider {
	if (!process.env[DEEPSEEK_API_KEY_ENV]) {
		throw new Error(
			`Provider "deepseek" requires the ${DEEPSEEK_API_KEY_ENV} environment variable, which is not set. ` +
				`Export ${DEEPSEEK_API_KEY_ENV} with your DeepSeek API key and re-run. ` +
				`(No key is written to any file, log, or run output.)`,
		);
	}

	const baseModel = getModels("deepseek").find((m) => m.id === DEEPSEEK_MODEL_ID) as Model<string> | undefined;
	if (!baseModel) {
		// Defensive: the built-in catalog is the source of truth for the id.
		throw new Error(
			`Provider "deepseek": built-in model "${DEEPSEEK_MODEL_ID}" not found in pi's model catalog. ` +
				`Available: ${getModels("deepseek")
					.map((m) => m.id)
					.join(", ")}.`,
		);
	}
	const model = opts.contextWindow ? ({ ...baseModel, contextWindow: opts.contextWindow } as Model<string>) : baseModel;

	return {
		providerName: "deepseek",
		// The native provider needs no registered config; expose an empty one so the
		// interface stays uniform. run.ts never registers it (register: false).
		config: {},
		model,
		modelRef: `deepseek/${model.id}`,
		getCallCount: () => 0,
		getSummarizerTokens: () => ({ ...NO_SUMMARIZER }),
		cacheSignalPresent: true, // real usage.cacheRead is recorded (not forced to null)
		register: false,
		runtimeApiKey: undefined, // env-resolved by pi's native auth; never shadow it
	};
}

/** Configurable parameters for the generic OpenAI-compatible provider. */
export interface OpenAICompatOptions {
	/** API endpoint base URL, e.g. "https://api.mimo.example". */
	baseUrl: string;
	/** Model identifier to select at this endpoint. */
	modelId: string;
	/** Name of the environment variable holding the API key (e.g. "MIMO_API_KEY"). */
	apiKeyEnv: string;
	/** Provider name used for registration/model namespacing. Defaults to "openai-compat". */
	providerName?: string;
	/**
	 * Whether this endpoint emits a genuine cache-read signal. Defaults to false:
	 * Mimo-style endpoints have historically shown none (per earlier project docs),
	 * so cacheRead is recorded as null rather than a misleading 0. Configurable for
	 * endpoints that do surface it.
	 */
	cacheSignalPresent?: boolean;
	/** Context window for the registered model. Defaults to 128000. */
	contextWindow?: number;
	/** Max output tokens for the registered model. Defaults to 8192. */
	maxTokens?: number;
}

/**
 * Generic OpenAI-compatible provider (covers Mimo-style endpoints pi does not
 * know natively). UNLIKE deepseek, this is NOT a built-in, so it is registered
 * via `pi.registerProvider` (run.ts does this because `register: true`) with a
 * ProviderConfig whose `api: "openai-completions"` routes to pi's OWN built-in
 * OpenAI-completions HTTP handler — no request/response/streaming code is written
 * here. The key is supplied as a `"$ENV_VAR"` interpolation in `config.apiKey`;
 * pi resolves it lazily at request time (resolve-config-value.ts), so the actual
 * key value never enters any field this code writes, logs, or serialises.
 *
 * Fail-fast: when the configured env var is unset we raise a specific, actionable
 * error naming that variable — before any session or network path. Only the
 * variable NAME appears; no key value is read or embedded.
 */
function openAICompatProvider(opts: OpenAICompatOptions): ExperimentProvider {
	const providerName = opts.providerName ?? "openai-compat";
	if (!opts.baseUrl) throw new Error(`Provider "${providerName}" requires a baseUrl.`);
	if (!opts.modelId) throw new Error(`Provider "${providerName}" requires a modelId.`);
	if (!opts.apiKeyEnv) throw new Error(`Provider "${providerName}" requires an apiKeyEnv (env var name for the key).`);

	if (!process.env[opts.apiKeyEnv]) {
		throw new Error(
			`Provider "${providerName}" requires the ${opts.apiKeyEnv} environment variable, which is not set. ` +
				`Export ${opts.apiKeyEnv} with the API key for ${opts.baseUrl} and re-run. ` +
				`(No key is written to any file, log, or run output.)`,
		);
	}

	const contextWindow = opts.contextWindow ?? 128000;
	const maxTokens = opts.maxTokens ?? 8192;

	const model: Model<string> = {
		id: opts.modelId,
		name: opts.modelId,
		api: "openai-completions",
		provider: providerName,
		baseUrl: opts.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	} as Model<string>;

	// `apiKey` is a "$ENV_VAR" template — pi resolves it lazily per request. The
	// actual secret is NEVER materialised into this object or anything run.ts writes.
	const config: ProviderConfig = {
		name: providerName,
		api: "openai-completions",
		baseUrl: opts.baseUrl,
		apiKey: `$${opts.apiKeyEnv}`,
		models: [
			{
				id: opts.modelId,
				name: opts.modelId,
				api: "openai-completions",
				baseUrl: opts.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens,
			},
		],
	};

	return {
		providerName,
		config,
		model,
		modelRef: `${providerName}/${opts.modelId}`,
		getCallCount: () => 0,
		getSummarizerTokens: () => ({ ...NO_SUMMARIZER }),
		cacheSignalPresent: opts.cacheSignalPresent ?? false,
		register: true, // not a pi built-in; the config must be registered
		runtimeApiKey: undefined, // key comes from the "$ENV_VAR" template, resolved by pi
	};
}

/**
 * Resolve a provider by name.
 *
 * - "mock"          — scripted, no-network provider (G1b). Registered config.
 * - "deepseek"      — pi's NATIVE built-in DeepSeek provider (no registration;
 *                     DEEPSEEK_API_KEY resolved by pi's own auth).
 * - "openai-compat" — generic OpenAI-compatible endpoint (Mimo-style), registered
 *                     via a ProviderConfig routed to pi's openai-completions handler.
 *
 * The openai-compat branch needs baseUrl / modelId / apiKeyEnv; supply them via
 * `opts.openAICompat`. Both real branches fail fast with a specific, env-var-named
 * error when their key material is absent, and never emit any key value.
 */
export function resolveProvider(name: string, scenario: Scenario, opts: ProviderOptions = {}): ExperimentProvider {
	switch (name) {
		case "mock":
			return mockProvider(scenario, opts);
		case "deepseek":
			return deepseekProvider(opts);
		case "openai-compat": {
			if (!opts.openAICompat) {
				throw new Error(
					`Provider "openai-compat" requires baseUrl, modelId and apiKeyEnv. ` +
						`Pass them via ProviderOptions.openAICompat.`,
				);
			}
			return openAICompatProvider(opts.openAICompat);
		}
		default:
			throw new Error(
				`Unknown provider "${name}". Known: mock, deepseek, openai-compat. ` +
					`(Real providers are wired in lib/provider.ts; see G2.)`,
			);
	}
}

export const DEFAULT_PROVIDER = "mock";

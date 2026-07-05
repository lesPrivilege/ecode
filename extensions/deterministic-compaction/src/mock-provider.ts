/**
 * Scripted mock provider for the no-key smoke test (Task 4 / correction #4).
 *
 * Registered through `pi.registerProvider(name, { api, baseUrl, apiKey, models,
 * streamSimple })` — the packet-mandated path (types.ts:1360). The `streamSimple`
 * handler replays a fixed, deterministic sequence of assistant turns keyed by
 * call count: turn N returns the Nth scripted step. Each step is a plain
 * `AssistantMessage` (text and/or `toolCall` blocks). The real pi agent loop
 * consumes the emitted stream, executes any tool calls against the real built-in
 * tools, appends the resulting `toolResult` messages, and calls back in for the
 * next turn — so write/edit/read genuinely round-trip through the loop and the
 * `context` hook fires on every call. No network and no API key are used.
 *
 * A model registered this way is dispatched by the global `streamSimple`
 * (pi-ai/compat) via the registered `api`, so selecting the mock model routes
 * here (model-registry.ts:903-909).
 */

import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One assistant content block in a scripted step. */
export type ScriptedBlock = TextContent | ToolCall;

export function text(value: string): TextContent {
	return { type: "text", text: value };
}

export function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

/** A single scripted assistant turn. `usage` lets a test seed a token estimate. */
export interface ScriptedStep {
	content: ScriptedBlock[];
	/** Defaults to "toolUse" when the step has tool calls, else "stop". */
	stopReason?: AssistantMessage["stopReason"];
	usage?: Partial<Usage>;
}

export interface MockProviderOptions {
	providerName: string;
	api: string;
	modelId: string;
	modelName?: string;
	contextWindow?: number;
	maxTokens?: number;
	steps: ScriptedStep[];
}

export interface MockProviderHandle {
	config: ProviderConfig;
	/** Number of times the provider stream was invoked (turns served). */
	getCallCount(): number;
	/** Remaining scripted steps not yet served. */
	getPendingCount(): number;
	/** Fully-qualified model reference "provider/modelId" for session selection. */
	modelRef: string;
}

function buildMessage(step: ScriptedStep, model: Model<string>): AssistantMessage {
	const hasToolCalls = step.content.some((b) => b.type === "toolCall");
	return {
		role: "assistant",
		content: step.content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE, ...step.usage },
		stopReason: step.stopReason ?? (hasToolCalls ? "toolUse" : "stop"),
		timestamp: Date.now(),
	};
}

/**
 * Build a mock provider config + handle. Register the returned `config` via
 * `pi.registerProvider(providerName, config)`; select the model with `modelRef`.
 */
export function createMockProvider(options: MockProviderOptions): MockProviderHandle {
	const steps = [...options.steps];
	const state = { callCount: 0 };

	const model: Model<string> = {
		id: options.modelId,
		name: options.modelName ?? options.modelId,
		api: options.api,
		provider: options.providerName,
		baseUrl: "http://localhost:0/mock",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 200000,
		maxTokens: options.maxTokens ?? 8192,
	} as Model<string>;

	const streamSimple = (
		requestModel: Model<string>,
		_context: Context,
		_streamOptions?: SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const stream = createAssistantMessageEventStream();
		const step = steps.shift();
		state.callCount++;

		queueMicrotask(() => {
			if (!step) {
				const errored: AssistantMessage = {
					role: "assistant",
					content: [],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: ZERO_USAGE,
					stopReason: "error",
					errorMessage: "mock-provider: no more scripted steps",
					timestamp: Date.now(),
				};
				stream.push({ type: "error", reason: "error", error: errored });
				stream.end(errored);
				return;
			}

			const message = buildMessage(step, requestModel);
			stream.push({ type: "start", partial: { ...message, content: [] } });
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				stream.push({ type: "done", reason: message.stopReason, message });
			}
			stream.end(message);
		});

		return stream;
	};

	const config: ProviderConfig = {
		name: options.modelName ?? options.providerName,
		api: options.api as ProviderConfig["api"],
		baseUrl: "http://localhost:0/mock",
		// A literal key so auth resolution never blocks; the handler ignores it.
		apiKey: "mock-key",
		streamSimple,
		models: [
			{
				id: model.id,
				name: model.name,
				api: options.api as ProviderConfig["api"],
				baseUrl: model.baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	};

	return {
		config,
		getCallCount: () => state.callCount,
		getPendingCount: () => steps.length,
		modelRef: `${options.providerName}/${options.modelId}`,
	};
}

/** Convenience: register a mock provider on the ExtensionAPI in one call. */
export function registerMockProvider(pi: ExtensionAPI, options: MockProviderOptions): MockProviderHandle {
	const handle = createMockProvider(options);
	pi.registerProvider(options.providerName, handle.config);
	return handle;
}

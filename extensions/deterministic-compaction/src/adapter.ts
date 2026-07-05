/**
 * Adapter: pi `AgentMessage[]` <-> compaction-core `Message[]`.
 *
 * compaction-core operates on a flat, harness-agnostic message model
 * (see @ecode/compaction-core `types.ts`): assistant messages carry a
 * `toolCalls[]` array, and tool results are their own `role: "tool"` messages
 * paired to a call by `toolCallId`. pi's `AgentMessage` union instead nests
 * `toolCall` blocks inside `assistant.content` and models tool results as a
 * separate `role: "toolResult"` message. This module bridges the two shapes so
 * `compactCodeProductions` can run on a pi transcript and the projected result
 * can be mapped back into `AgentMessage[]` for the outgoing send payload.
 *
 * Correction #1 (per docs/g0-survey.md Item 1): pi's `read` tool result is
 * plain file text with NO `path` prefix and NO content hash. So path/hash
 * extraction cannot read a hashline out of the result body. Instead the adapter
 * relies on compaction-core's documented degraded path: the read result's
 * paired `read` toolCall carries `{ path, offset?, limit? }` in its arguments,
 * and `compactCodeProductions` resolves the path from those arguments
 * (`extractPath(parsedArgs)`) when the injected extractor yields no path. We
 * inject `pathLineCountExtractor` (never emits a hash) to make the degradation
 * explicit; `hash` therefore stays `undefined`, matching the plain-text format.
 *
 * Only `Message`-shaped `AgentMessage`s (user / assistant / toolResult) are
 * meaningful to compaction. Custom app messages (branch summaries, compaction
 * summaries, notifications, etc.) are passed through untouched by index so the
 * mapped-back array is 1:1 with the input and nothing custom is lost.
 */

import type {
	AssistantMessage,
	Message as PiMessage,
	ToolCall as PiToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	Message as CoreMessage,
	ToolCall as CoreToolCall,
} from "./compaction-core.js";

/** A pi `AgentMessage` that is one of the three LLM message shapes. */
type PiLlmMessage = PiMessage;

function isPiLlmMessage(m: AgentMessage): m is PiLlmMessage {
	// AgentMessage = Message | CustomAgentMessages[...]. The three LLM roles are
	// the only ones compaction understands; everything else is a custom message.
	return m.role === "user" || m.role === "assistant" || m.role === "toolResult";
}

function assistantTextAndThinking(content: AssistantMessage["content"]): {
	text: string;
	thinking: string;
} {
	let text = "";
	let thinking = "";
	for (const block of content) {
		if (block.type === "text") {
			text += (text ? "\n" : "") + block.text;
		} else if (block.type === "thinking") {
			thinking += (thinking ? "\n" : "") + block.thinking;
		}
	}
	return { text, thinking };
}

function piToolCallToCore(block: PiToolCall): CoreToolCall {
	return {
		id: block.id,
		name: block.name,
		// compaction-core accepts `unknown` and JSON-stringifies as needed; pi
		// tool-call arguments are already a structured object.
		arguments: block.arguments,
	};
}

function textFromToolResultContent(content: ToolResultMessage["content"]): string {
	// pi tool results carry `(TextContent | ImageContent)[]`. compaction summarises
	// text bodies; image blocks are represented by a short placeholder so their
	// presence is reflected in char/line counts without inflating the body.
	return content
		.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`))
		.join("\n");
}

/**
 * Convert a pi `AgentMessage[]` into the compaction-core `Message[]` model.
 *
 * The returned `coreMessages` is index-aligned with `input` for every
 * LLM-shaped message. Custom (non-LLM) messages are recorded in `passthrough`
 * keyed by their original index so {@link fromCore} can restore them verbatim.
 * Deterministic synthetic ids are assigned when a pi message has no natural id,
 * so compaction diffs are stable across identical inputs (idempotency).
 */
export interface ToCoreResult {
	coreMessages: CoreMessage[];
	/** original index -> original AgentMessage, for messages compaction skips */
	passthrough: Map<number, AgentMessage>;
	/** coreMessages index -> original input index (LLM messages only) */
	coreIndexToInputIndex: number[];
}

export function toCore(input: AgentMessage[]): ToCoreResult {
	const coreMessages: CoreMessage[] = [];
	const passthrough = new Map<number, AgentMessage>();
	const coreIndexToInputIndex: number[] = [];

	input.forEach((msg, index) => {
		if (!isPiLlmMessage(msg)) {
			passthrough.set(index, msg);
			return;
		}

		const createdAt =
			typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date(0).toISOString();
		const id = `m${index}`;

		if (msg.role === "user") {
			coreMessages.push({ id, role: "user", content: textFromUserContent(msg.content), createdAt });
		} else if (msg.role === "assistant") {
			const { text, thinking } = assistantTextAndThinking(msg.content);
			const toolCalls = msg.content
				.filter((b): b is PiToolCall => b.type === "toolCall")
				.map(piToolCallToCore);
			coreMessages.push({
				id,
				role: "assistant",
				content: text,
				thinking: thinking || undefined,
				toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
				createdAt,
			});
		} else {
			// toolResult
			const content = textFromToolResultContent(msg.content);
			coreMessages.push({
				id,
				role: "tool",
				content,
				toolCallId: msg.toolCallId,
				toolName: msg.toolName,
				// compaction-core reads error state from meta.isError / meta.is_error.
				meta: { isError: msg.isError === true },
				createdAt,
			});
		}

		coreIndexToInputIndex.push(index);
	});

	return { coreMessages, passthrough, coreIndexToInputIndex };
}

function textFromUserContent(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : `[image:${block.mimeType}]`)).join("\n");
}

/**
 * Map a compacted compaction-core `Message[]` back onto the original
 * `AgentMessage[]`, producing a new array suitable for the outgoing send
 * payload. Only the fields compaction can change are written back:
 *
 * - assistant `toolCall` block `arguments` (write/edit code-production summaries)
 * - `toolResult` text content (read/bash/search/find result summaries)
 *
 * Everything else on each message is preserved from the original. Custom
 * messages are restored from `passthrough` at their original indices, so the
 * output length and ordering exactly match the input.
 */
export function fromCore(input: AgentMessage[], core: ToCoreResult, projected: CoreMessage[]): AgentMessage[] {
	// Build original-index -> projected core message.
	const projectedByInputIndex = new Map<number, CoreMessage>();
	projected.forEach((coreMsg, coreIdx) => {
		const inputIdx = core.coreIndexToInputIndex[coreIdx];
		if (inputIdx !== undefined) projectedByInputIndex.set(inputIdx, coreMsg);
	});

	return input.map((original, index) => {
		if (core.passthrough.has(index)) {
			return core.passthrough.get(index)!;
		}
		const coreMsg = projectedByInputIndex.get(index);
		if (!coreMsg) return original;

		if (original.role === "assistant") {
			return applyAssistantProjection(original, coreMsg);
		}
		if (original.role === "toolResult") {
			return applyToolResultProjection(original, coreMsg);
		}
		// user messages are never compacted; return as-is.
		return original;
	});
}

function applyAssistantProjection(original: AssistantMessage, coreMsg: CoreMessage): AssistantMessage {
	const compactedCalls = new Map<string, CoreToolCall>();
	for (const tc of coreMsg.toolCalls ?? []) {
		compactedCalls.set(tc.id, tc);
	}
	if (compactedCalls.size === 0) return original;

	let changed = false;
	const newContent = original.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const compacted = compactedCalls.get(block.id);
		if (!compacted) return block;
		// compaction replaces `arguments` with a CodeProductionSummary object when
		// (and only when) it compacted this call. Detect that and write it back.
		if (
			compacted.arguments !== block.arguments &&
			typeof compacted.arguments === "object" &&
			compacted.arguments !== null &&
			"compacted" in (compacted.arguments as Record<string, unknown>)
		) {
			changed = true;
			return { ...block, arguments: compacted.arguments as Record<string, any> };
		}
		return block;
	});

	if (!changed) return original;
	return { ...original, content: newContent };
}

function applyToolResultProjection(original: ToolResultMessage, coreMsg: CoreMessage): ToolResultMessage {
	// compaction rewrote `content` to a summary string and stamped meta.compacted.
	const wasCompacted =
		coreMsg.meta !== undefined &&
		typeof coreMsg.meta === "object" &&
		coreMsg.meta !== null &&
		"compacted" in coreMsg.meta;
	if (!wasCompacted) return original;

	const summaryText = coreMsg.content ?? "";
	const originalText = textFromToolResultContent(original.content);
	if (summaryText === originalText) return original;

	// Replace the (text) content with the single summary text block. Any image
	// blocks in the original result are dropped in the projection just as the
	// text body is summarised; this only affects the send payload, never disk.
	return {
		...original,
		content: [{ type: "text", text: summaryText }],
	};
}

/**
 * chars/4 monotonic token estimator (R3) — injected into clearToolUses as
 * `deps.estimateTokens`. Reads ONLY `content` / `thinking` / `toolCalls`
 * (name, JSON-serialized arguments, rawArguments) off the raw transcript.
 *
 * Deliberately never reads `.meta` (or any field resembling provider usage)
 * — this is the anti-recurrence line for the self-pollution failure mode
 * documented in note-projection-turn-variables-2026-07-08.md finding 1 and
 * codified in design R3: mixing provider usage feedback into the gate
 * reading makes the gate self-pollute from the very clearing it drives. Do
 * not import or call pi's `estimateContextTokens` here, and do not add a
 * `.meta` read to this function.
 */

import type { Message } from "./context-pruning.js";

export function estimateTokensCharsDiv4(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    chars += message.thinking?.length ?? 0;
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length;
      chars += JSON.stringify(call.arguments ?? {}).length;
      chars += call.rawArguments?.length ?? 0;
    }
  }
  return Math.ceil(chars / 4);
}

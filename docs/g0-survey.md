# G0 Survey — pi-mono source re-verification

Fresh clone of `https://github.com/badlogic/pi-mono` at
`/Users/lesprivilege/Projects/ecode/pi/`.

- Clone HEAD: `ee24a9ec54a9602d55dc7ac767c270cec806c291` — "feat(ai): refresh generated model catalogs" (2026-07-04, branch `main`).
- `git remote -v` inside `pi/`: `origin https://github.com/badlogic/pi-mono.git` (fetch + push).
- Repo layout note: this is the **monorepo** `pi-mono`. The June baseline was read
  against a single-repo checkout of the same project family. The relevant code now
  lives across two packages:
  - `packages/coding-agent/` — the CLI / TUI app (`pi-coding-agent`), tools, extensions.
  - `packages/agent/` — the reusable harness (`@earendil-works/pi-agent-core`): agent
    loop, session, compaction primitives.
  - `packages/ai/` — the provider/API layer (`@earendil-works/pi-ai`).
  All citations below are from the fresh clone (absolute paths omit the
  `/Users/lesprivilege/Projects/ecode/pi/` prefix).

All facts are stated as the current source reads. No recommendations.

## Clone + basic-loop smoke test

- Clone: OK. Real `git clone` (history intact, origin = pi-mono, HEAD `ee24a9e`).
- Install: `npm install` (repo uses `package-lock.json`, npm workspaces — not pnpm),
  exit 0, "added 352 packages … found 0 vulnerabilities". Workspace symlinks wired
  (`node_modules/@earendil-works/pi-coding-agent -> packages/coding-agent`, etc.).
- Build: `npm run build` (tsgo across tui/ai/agent/coding-agent/orchestrator) succeeded;
  `packages/coding-agent/dist/cli.js` produced. `node dist/cli.js --version` → `0.80.3`.
- Basic agent loop end-to-end: **partially exercised — blocked at the provider-auth
  boundary for lack of credentials.** `node dist/cli.js -p --model
  anthropic/claude-sonnet-4-20250514 "Say the single word: pong" < /dev/null` initializes
  the agent, resolves the model, and stops with `No API key found for anthropic.` The only
  provider-related env var present is `ANTHROPIC_BASE_URL` (a base URL, no credential).
  No API key env var is set for any provider (checked ANTHROPIC_API_KEY /
  ANTHROPIC_OAUTH_TOKEN / OPENAI_API_KEY / DEEPSEEK_API_KEY / GEMINI_API_KEY /
  GROQ_API_KEY / OPENROUTER_API_KEY / CEREBRAS_API_KEY / MISTRAL_API_KEY / XAI_API_KEY /
  TOGETHER_API_KEY / FIREWORKS_API_KEY — all unset). The Anthropic provider requires
  `ANTHROPIC_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`
  (`packages/ai/src/providers/anthropic.ts:14`); a base URL alone does not authenticate.
  So the live model round-trip could not be made. Everything up to that call
  (CLI, arg parsing, model resolution, auth resolution) runs.
- Build artifacts: `dist/` output is gitignored. The build's `generate-*` scripts
  refreshed three tracked generated catalogs
  (`ai/src/image-models.generated.ts`, `ai/src/providers/mistral.models.ts`,
  `ai/src/providers/openrouter.models.ts`); these were reverted via `git checkout` so the
  tracked tree is byte-clean vs upstream (`git status` shows 0 modified tracked files).
  No pi/ source was hand-edited.

---

## Item 1 — `read` tool output format

**Verdict: no hashline / no `¶path#hash` structure. (No June baseline — established fresh.)**

File: `packages/coding-agent/src/core/tools/read.ts`.

The tool result content sent to the model is **plain file text**, optionally followed by
a bracketed continuation/truncation notice. There is no path prefix and no content hash
anywhere in the produced output.

- The text branch builds `outputText` as one of:
  - raw content: `outputText = truncation.content;` (read.ts:313)
  - content + continuation: `` outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]` `` (read.ts:301)
  - byte-limit variant of the same (read.ts:303)
  - user-limit remainder: `` `[${remaining} more lines in file. Use offset=${nextOffset} to continue.]` `` (read.ts:310)
  - first-line-too-large fallback pointing at `sed`/`head` (read.ts:293)
  and returns it as `content = [{ type: "text", text: outputText }]` (read.ts:315).
- No line-number gutter is added to the model-facing text either — line numbers appear
  only in the human continuation notice, not per line.
- Confirmed absent: a grep of the entire `packages/coding-agent/src/core/tools/`
  directory for `¶`, `#hash`, `hashLine`, `createHash`, `sha1`, `sha256` returns nothing.
- There is a separate TUI render path (`renderCall` read.ts:329, `renderResult`
  read.ts:339) that formats headers like `read <path>:start-end` for the terminal
  display, and a "compact read" classification that prints e.g. `read docs <label>` or
  `[skill] <label>` (formatCompactReadCall read.ts:140). These are **display-only** (the
  TUI component), not part of the tool-result content handed to the LLM, and still
  contain no hash.

Schema (for reference): `read` takes `{ path, offset?, limit? }` (readSchema read.ts:20-24).

---

## Item 2 — extension registration API (exact signature)

**Verdict: DRIFT — examples relocated from repo-root `examples/extensions/*` into the coding-agent package; `src/core/extensions/` part of the June location holds. (No exact signature captured in June — established fresh.)**

Core types file: `packages/coding-agent/src/core/extensions/types.ts`.
Examples: `packages/coding-agent/examples/extensions/` (NOT repo-root `examples/`).

Exact signatures as declared:

- Extension entry point (factory):
  `export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;`
  (types.ts:1447). In practice each example file is `export default function (pi: ExtensionAPI) { ... }`
  (e.g. `packages/coding-agent/examples/extensions/todo.ts:105`).

- Tool registration:
  `registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;`
  (types.ts:1198-1200). Live usage: `pi.registerTool({ name, label, description, parameters, async execute(...) })`
  (todo.ts:136-142).

- `ToolDefinition<TParams, TDetails, TState>` shape (types.ts:436-483):
  - `name: string` (types.ts:437)
  - `label: string` (types.ts:439)
  - `description: string` (types.ts:441)
  - `parameters: TParams` — a TypeBox `TSchema` (types.ts:447)
  - optional `promptSnippet?`, `promptGuidelines?`, `renderShell?`, `prepareArguments?`, `executionMode?`
  - `execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>` (types.ts:465-471)
  - optional `renderCall?`, `renderResult?` (types.ts:474-482)

- Event hook registration: overloaded `on(event, handler)` (types.ts:1152-1191), e.g.
  `on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;` (types.ts:1169)
  and `on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>): void;` (types.ts:1161-1164).
  Handler type:
  `export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;` (types.ts:1142).

- Other registration surface on `ExtensionAPI` (types.ts:1147-1379): `registerCommand`
  (1207), `registerShortcut` (1210), `registerFlag` (1219), `registerMessageRenderer`
  (1236), `registerEntryRenderer` (1239), `registerProvider` (1360),
  `unregisterProvider` (1375).

- Supporting extension source modules alongside `types.ts`:
  `packages/coding-agent/src/core/extensions/{index,loader,runner,wrapper}.ts`.

---

## Item 3 — the `context` hook

**Verdict: CONFIRMED — signature is still `AgentMessage[] → {messages?}`; the returned value is a purely send-time projection and never touches session persistence. (June's "presumably send-projection only" expectation is confirmed as fact.)**

- Hook wiring in the harness (moved from the June-quoted line 412):
  ```ts
  transformContext: async (messages) => {
      const result = await this.emitHook({ type: "context", messages: [...messages] });
      return result?.messages ?? messages;
  }
  ```
  `packages/agent/src/harness/agent-harness.ts:408-411`.

- Event + result types:
  `interface ContextEvent { type: "context"; messages: AgentMessage[]; }`
  (`packages/coding-agent/src/core/extensions/types.ts:655-658`) and
  `interface ContextEventResult { messages?: AgentMessage[]; }` (types.ts:1031-1033).
  So the type is `AgentMessage[] → { messages?: AgentMessage[] }` — unchanged from June.

- Persistence question (send-projection vs disk). `transformContext` is invoked inside
  `streamAssistantResponse` in the agent loop:
  ```ts
  let messages = context.messages;
  if (config.transformContext) {
      messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);
  ```
  `packages/agent/src/agent-loop.ts:283-289`. The transformed value is a **local
  variable** consumed only to build `llmContext` (`{ systemPrompt, messages: llmMessages, tools }`)
  for the outgoing stream request (agent-loop.ts:292-296). It is never passed to any
  `session.append*` / storage call. `transformContext` runs on every LLM call
  (once per turn, before `convertToLlm`), and its output affects only the request
  payload, not the persisted session tree. Confirmed send-time projection only; does
  not touch disk.

---

## Item 4 — the `session_before_compact` hook (`{compaction}` return)

**Verdict: CONFIRMED — the hook can still return `{compaction}`; pi uses it in place of its own LLM `compact()` and persists it as a compaction entry flagged `fromHook: true`. Matches June baseline.**

Harness wiring in `AgentHarness.compact()`
(`packages/agent/src/harness/agent-harness.ts:686-730`):

```ts
const hookResult = await this.emitHook({
    type: "session_before_compact",
    preparation, branchEntries, customInstructions,
    signal: new AbortController().signal,
});                                                            // :699-705
if (hookResult?.cancel) throw new AgentHarnessError("compaction", "Compaction cancelled"); // :706
const provided = hookResult?.compaction;                      // :707
const compactResult = provided
    ? { ok: true as const, value: provided }                  // :709  <- uses hook value
    : await compact(preparation, this.models, model, ...);    // :710  <- else pi's own LLM compact()
// ...
const entryId = await this.session.appendCompaction(
    result.summary, result.firstKeptEntryId, result.tokensBefore, result.details,
    provided !== undefined,                                   // :718  <- fromHook flag
);
// ...
await this.emitOwn({ type: "session_compact", compactionEntry: entry,
    fromHook: provided !== undefined });                      // :722
```

- Result type: `interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }`
  (`packages/coding-agent/src/core/extensions/types.ts:1077-1080`).
- `CompactionResult` = `{ summary; firstKeptEntryId; tokensBefore; details? }`
  (`packages/agent/src/harness/compaction/compaction.ts:89-98`).
- The `fromHook` flag persisted on the entry is later honored: on the next compaction,
  a hook-originated previous compaction's `details` are skipped for file-op extraction —
  `if (!prevCompaction.fromHook && prevCompaction.details) { ... }`
  (compaction.ts:43).
- Canonical example returning `{compaction}` to replace default behavior:
  `packages/coding-agent/examples/extensions/custom-compaction.ts:114-120`
  (`return { compaction: { summary, firstKeptEntryId, tokensBefore } };`), header comment
  "Replaces the default compaction behavior" (custom-compaction.ts:4).

---

## Item 5 — pi-ai OpenAI-compatible cache-field passthrough (DeepSeek `prompt_cache_hit_tokens`)

**Verdict: CONFIRMED-PRESERVED — DeepSeek's `prompt_cache_hit_tokens` is preserved (mapped to cache-read tokens), not dropped. (Genuinely new territory; June never checked DeepSeek.)**

- DeepSeek provider routes through the OpenAI-completions API:
  `api: openAICompletionsApi()` in `packages/ai/src/providers/deepseek.ts:13`
  (`Provider<"openai-completions">`, baseUrl `https://api.deepseek.com`,
  env key `DEEPSEEK_API_KEY`).

- The OpenAI-completions usage parser explicitly declares and reads the field:
  ```ts
  function parseChunkUsage(rawUsage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_cache_hit_tokens?: number;                                    // :1114
      prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      ...
  }, model) {
      const promptTokens = rawUsage.prompt_tokens || 0;
      const cacheReadTokens =
          rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;  // :1121
      const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
      const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);                // :1132
      // -> usage.cacheRead = cacheReadTokens                                                       // :1138
  }
  ```
  `packages/ai/src/api/openai-completions.ts:1110-1144`.

- So when a provider (like DeepSeek) reports `prompt_cache_hit_tokens` instead of the
  OpenAI-style `prompt_tokens_details.cached_tokens`, it is read via the `??` fallback at
  line 1121 and surfaced as `usage.cacheRead` (line 1138), and subtracted from `input`
  (line 1132). The field is not silently dropped.
- Corroborating tests exercising the OpenAI-completions cache mapping:
  `packages/ai/test/openai-completions-prompt-cache.test.ts`,
  `packages/ai/test/openai-completions-tool-choice.test.ts:1435-1515` ("preserves
  prompt_tokens_details cache read/write fields ..."). A dedicated helper module also
  exists: `packages/ai/src/api/openai-prompt-cache.ts`.

---

## Compaction defaults (pi's own native compaction — NOT taucode's module)

**Verdict: CONFIRMED — `reserveTokens = 16384`, `keepRecentTokens = 20000`. Values match June. The June-cited path still exists and still holds these values (see path note below).**

Values appear identically in three current locations:

1. Harness primitive (the exact path June cited):
   `packages/agent/src/harness/compaction/compaction.ts:111-115`
   ```ts
   export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
       enabled: true,
       reserveTokens: 16384,     // :113
       keepRecentTokens: 20000,  // :114
   };
   ```
   This is the default passed into `AgentHarness.compact()` via
   `prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS)`
   (agent-harness.ts:695, imported agent-harness.ts:14).

2. Coding-agent's own copy of the same constant (used by the CLI's own compaction module):
   `packages/coding-agent/src/core/compaction/compaction.ts:122-125` — identical values
   (`reserveTokens: 16384`, `keepRecentTokens: 20000`).

3. The values actually applied at CLI runtime resolve through `SettingsManager`, which
   hardcodes the same fallbacks:
   `packages/coding-agent/src/core/settings-manager.ts:770` (`reserveTokens ?? 16384`) and
   `:774` (`keepRecentTokens ?? 20000`), surfaced via `getCompactionSettings()` (:777-782)
   and consumed by `AgentSession` (`this.settingsManager.getCompactionSettings()`,
   e.g. agent-session.ts:1691, 1842, 1936).

Path note: the June baseline cited
`packages/agent/src/harness/compaction/compaction.ts` — that exact path is present in the
current monorepo and still holds `16384` / `20000` (location 1 above). No path drift for
the specific June citation; the monorepo additionally carries a second copy in the
coding-agent package (location 2) plus the runtime resolver (location 3).

Related but distinct: `reserveTokens = 16384` also defaults inside branch summarization
(`packages/agent/src/harness/compaction/branch-summarization.ts:203`;
`packages/coding-agent/src/core/compaction/branch-summarization.ts:299`) — that is the
branch-summary path, not the main compaction settings.

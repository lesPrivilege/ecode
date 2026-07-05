# experiments — JSONL output schema & harness reference

The 4-arm (A/B/C/D) compaction experiment harness. Three entry points over the
G1b `deterministic-compaction` extension + a pluggable mock provider. Mock-only;
real providers swap in at G2 via `lib/provider.ts` (a config change, not a code
change). All numbers this harness produces are from synthetic smoke fixtures —
they are **not** experimental findings and no quality/performance conclusions are
drawn anywhere.

## Entry points

```
# print the manifest of runs + where output lands (calls no provider):
node plan.ts --arms A,B,C,D --scenario refactor [--compact-after N] [--keep-recent N] [--sweep 16000,64000] [--out-dir results]

# drive ONE arm against ONE scenario in-process, emit a JSONL metrics file:
node --import ./lib/register.mjs run.ts --arm C --scenario refactor --out results/refactor-C.jsonl \
     [--compact-after 32000] [--keep-recent 3] [--provider mock] [--seam-b]

# read N JSONL files, compute deltas vs baseline, apply the invalid/suspicious gates:
node --import ./lib/register.mjs compare.ts --in a.jsonl --in b.jsonl ... --baseline A [--json]
```

`run.ts` and `compare.ts` are launched with `--import ./lib/register.mjs`, a
native Node ESM resolve hook (`lib/loader.mjs`) that aliases the `@earendil-works/*`
pi packages to their workspace `src` (pi is consumed from source, never built) and
rewrites TS-idiomatic `.js` import specifiers to their `.ts` files. `plan.ts` has no
pi imports and runs under plain `node`. Tests run via `npm test` (vitest, same alias
strategy as `extensions/deterministic-compaction`).

## The 4 arms (`lib/arms.ts`)

| Arm | Native pi compaction | Seam-A hook | Seam-B | How built |
| --- | --- | --- | --- | --- |
| A | OFF | no | no | `settingsManager.setCompactionEnabled(false)`, no G1b hook |
| B | ON (pi default) | no | no | native on; totals include the summariser's own tokens |
| C | OFF | yes | no | G1b seam-A only (isolated); `compactAfterInputTokens` is the sweep surface |
| D | ON (seam-B intercepts) | yes | yes | seam-A + native-triggered deterministic seam-B checkpoint (no LLM summary) |

Arm A's disable is **not** the hardcoded `DEFAULT_COMPACTION_SETTINGS` in
`agent/.../compaction.ts` (that only backs the low-level `harness.compact()`
primitive). The app-level auto-compaction trigger reads the SettingsManager:
`agent-session.ts` `_checkCompaction` does `if (!settingsManager.getCompactionSettings().enabled) return false`.
So `setCompactionEnabled(false)` disables it with no pi patch. Arm D keeps native
ON because seam-B (`session_before_compact`) only fires when native compaction
triggers — it then replaces pi's LLM summary with a deterministic checkpoint.

## Row schema (one JSONL file per arm-run)

Every numeric field is a top-level number (or explicit `null`) so a tolerant
reader (`lib/read-run.ts`, modelled on taucode dogfood-p0's `numberField`) can
consume it. Files start with `#` comment lines (ignored by the reader).

### `type: "meta"` (one, first)

| field | meaning |
| --- | --- |
| `schema_version` | schema version (currently 1) |
| `arm`, `arm_label`, `scenario`, `provider` | run identity |
| `mechanism.native_compaction_enabled` | native pi compaction on for this arm |
| `mechanism.seam_a_installed` / `seam_b_installed` | G1b hooks installed |
| `mechanism.compact_after_input_tokens` / `keep_recent_assistant_messages` | seam-A params (null when no seam-A) |
| `started_at` | ISO timestamp |
| `data_kind` | always `"synthetic-smoke-fixture"` |

### `type: "turn"` (one per LLM call)

| field | meaning |
| --- | --- |
| `turn` | 1-based turn index |
| `input_tokens` | content-based estimate of the ACTUAL payload sent this turn (post-compaction for seam-A arms). Uses pi's per-message `estimateTokens` summed (`estimatePayloadTokens`), which — unlike the usage-based `estimateContextTokens` — is compaction-sensitive. |
| `output_tokens` | provider `usage.output` when present, else estimate from assistant text |
| `output_from_usage` | true when `output_tokens` came from usage |
| `tool_calls` | tool calls in this turn's assistant message |
| `read_calls` | `read` tool calls this turn |
| `re_reads` | read calls this turn targeting a path already read earlier in the run |
| `compacted_path_re_reads` | read calls this turn targeting a path already compacted earlier |
| `projected` | seam-A projected (compacted) this turn's outgoing payload |
| `cache_read_tokens` | `usage.cacheRead` when the provider gives a signal, else **`null`** (mock) |
| `completion` | empty placeholder for later human fill-in (never computed) |

### `type: "summary"` (one, last)

Roll-up: `total_input_tokens`, `total_output_tokens` (both INCLUDE the native
summariser's own tokens for arm B), `total_tool_calls`, `total_read_calls`,
`total_re_reads`, `compacted_path_count`, `total_compacted_path_re_reads`,
`compacted_path_re_read_rate`, `projected_turn_count`,
`native_compactions_observed`, `summarizer_calls` / `summarizer_input_tokens` /
`summarizer_output_tokens`, `total_cache_read_tokens` (null when no turn had a
signal), `cache_signal_present`, `completion`, `data_kind`.

## Metric formulas (exact)

- **re_read_count**: a `read` whose target path (the `path` argument, exact string,
  no normalisation) was already the target of an earlier `read` in the same run.
  First read of a path is not a re-read; each later read of it is +1.
- **compacted_paths**: the set of paths whose `read` RESULT was actually compacted
  (summarised) by the seam-A hook at least once during the run.
- **compacted_path_re_reads**: count of `read` calls, at any later turn, whose path
  is in `compacted_paths`.
- **compacted_path_re_read_rate** = `compacted_path_re_reads / total_read_calls`
  (fraction of ALL reads that hit an already-compacted path). Denominator is total
  reads — the always-defined base, comparable across arms with different read
  volumes. `null` when there are zero reads. This is the metric that catches
  taucode's documented false-savings case (tokens down while churn up).
- **cache**: `usage.cacheRead` verbatim when present; explicit **`null`** when the
  provider gives no signal (the mock). `null` = "no signal", `0` = "confirmed no
  cache hit" — kept distinct (g0-survey Item 5).

## Judgment gates (`lib/gates.ts`, unit-tested in `test/gates.test.ts`)

- **invalid**: the arm's mechanism never engaged, so a comparison is meaningless.
  Seam-A arm with `projected_turn_count == 0` (threshold never crossed); native-on
  arm with `native_compactions_observed == 0`; or any run with `turn_count == 0`.
  The baseline arm A ("no compaction" IS its engaged state) is never invalid on
  this basis.
- **suspicious** (false-savings): vs. the baseline arm A, total tokens went DOWN
  AND churn went UP (re-read count increased, or compacted-path re-read rate
  increased). Never fires for the baseline against itself, nor when tokens went up.

Both gates return a boolean + machine-readable reasons; they do not editorialise.

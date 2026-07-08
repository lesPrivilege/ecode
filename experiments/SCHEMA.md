# experiments — JSONL output schema & harness reference

The 4-arm (A/B/C/D) compaction experiment harness. Three entry points run over
the `deterministic-compaction` extension and a pluggable provider layer. The
provider may be the scripted mock fixture or a real provider such as DeepSeek /
OpenAI-compatible endpoints via `lib/provider.ts`.

Fixture runs are tagged `synthetic-smoke-fixture` and are never experimental
findings. Packet runs are tagged as real workload data, preserve provider/cache
signals when available, and are the source for the R2 reports under
`docs/reports/`.

## Entry points

```
# print the manifest of runs + where output lands (calls no provider):
node plan.ts --arms A,B,C,D --scenario refactor [--compact-after N] [--keep-recent N] [--sweep 16000,64000] [--out-dir results]

# drive ONE arm against ONE scenario in-process, emit a JSONL metrics file:
node --experimental-transform-types --import ./lib/register.mjs run.ts --arm C --scenario refactor --out results/refactor-C.jsonl \
     [--compact-after 32000] [--keep-recent 3] [--provider mock|deepseek|openai-compat] [--seam-b]

# read N JSONL files, compute deltas vs baseline, apply the invalid/suspicious gates:
node --experimental-transform-types --import ./lib/register.mjs compare.ts --in a.jsonl --in b.jsonl ... --baseline A [--json]
```

`--experimental-transform-types` is required (not just strip-types): the DC
extension's `tuning.ts` uses TS parameter properties, which strip-only mode
cannot parse (doc fix 2026-07-08; the requirement itself predates G4c).
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
| `mechanism.extension_flags` | effective EXP-WS/default-off feature flags for this run |
| `mechanism.placebo_tail_target_tokens` | C+PL local placebo target, null outside placebo arms |
| `mechanism.extension_flags.compact_nudge_tail` | C+N fixed short nudge tail flag |
| `mechanism.ws_declare_nudge` | WS-2.5 measurement mode (`off` or `every-turn`) |
| `mechanism.trc_installed` | G4c: frontier-pruning's own `context` hook installed (TRC, arm T) |
| `mechanism.trc_config` | TRC's effective config when `trc_installed` (`trigger_tokens`, `keep`, `clear_at_least`, `exclude_tools`, `clear_tool_inputs`, `preserve_error_results`); `null` otherwise |
| `started_at` | ISO timestamp |
| `data_kind` | `"synthetic-smoke-fixture"` for registry fixtures; real packet runs are tagged as real workload data |

### `type: "turn"` (one per LLM call)

| field | meaning |
| --- | --- |
| `turn` | 1-based turn index |
| `input_tokens` | content-based estimate of the ACTUAL payload sent this turn (post-compaction for seam-A arms). Uses pi's per-message `estimateTokens` summed (`estimatePayloadTokens`), which — unlike the usage-based `estimateContextTokens` — is compaction-sensitive. |
| `output_tokens` | provider `usage.output` when present, else estimate from assistant text |
| `output_from_usage` | true when `output_tokens` came from usage |
| `reasoning_tokens` | provider reasoning tokens when reported, else `null` |
| `tool_calls` | tool calls in this turn's assistant message |
| `read_calls` | `read` tool calls this turn |
| `re_reads` | read calls this turn targeting a path already read earlier in the run |
| `compacted_path_re_reads` | read calls this turn targeting a path already compacted earlier |
| `cleared_path_re_reads` | G4c: read calls this turn targeting a path already cleared by TRC earlier (isomorphic to `compacted_path_re_reads`, kept side-by-side, never merged into it) |
| `trc` | G4c: TRC's per-turn projection report — `{applied, clearedToolUses, clearedInputTokensEst, gateReading}` (Est = estimator units, chars/4, not a real provider token count); `null` when TRC is not installed for this arm |
| `projected` | seam-A projected (compacted) this turn's outgoing payload |
| `cache_read_tokens` | `usage.cacheRead` when the provider gives a signal, else **`null`** (mock) |
| `tail_blocks` | OBS-TAIL evidence blocks injected or substituted on this turn; each block has `source`, `line_count`, and `content_hash` |
| `anchor_lines` / `anchor_hash` | OBS-TAIL shortcut for the anchor block; `0` / `null` when absent |
| `completion` | empty placeholder for later human fill-in (never computed) |

### `type: "sideband"` (zero or more, C-SB only)

| field | meaning |
| --- | --- |
| `turn` | projection turn that scheduled the sideband summary |
| `path`, `hash` | source view identity summarized by the sideband call |
| `record_id` | canonical summary record id stored in the semantic ledger |
| `model` | provider/model label for the sideband call |
| `input_tokens` / `output_tokens` | provider-unit sideband usage included in summary totals |
| `text_hash` | SHA-256/16 hash of the summary text (text itself is not copied into run JSONL) |
| `source_hashes` | source view hashes covered by this summary |

### `type: "summary"` (one, last)

Roll-up: `total_input_tokens`, `total_output_tokens` (both INCLUDE the native
summariser's own tokens for arm B), `total_tool_calls`, `total_read_calls`,
`total_re_reads`, `compacted_path_count`, `total_compacted_path_re_reads`,
`compacted_path_re_read_rate`, `projected_turn_count`,
`native_compactions_observed`, `summarizer_calls` / `summarizer_input_tokens` /
`summarizer_output_tokens`, `sideband_calls` / `sideband_input_tokens` /
`sideband_output_tokens`, `total_cache_read_tokens` (null when no turn had a
signal), `total_reasoning_tokens` (null when no turn had a signal),
`cache_signal_present`, `completion`, `data_kind`.

G4c adds (isomorphic to the `compacted_path_*` fields above, arm T only —
0 on any arm where TRC is not installed): `cleared_path_count` (distinct
paths TRC cleared at least once), `total_cleared_path_re_reads` (reads
targeting an already-TRC-cleared path).

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
- **cleared_paths** (G4c): the set of `read`-tool paths whose paired result TRC
  actually cleared (content replaced with the placeholder) at least once during
  the run — isomorphic to `compacted_paths`, tracked separately. A path whose
  `clearToolInputs` ALSO wiped the toolCall's `path` argument (path no longer
  observable in the outgoing transcript, not just its content) is excluded from
  this set: that is a structurally stronger failure mode than "content cleared,
  path still visible", so conflating the two would corrupt the isomorphism.
- **cleared_path_re_reads**: count of `read` calls, at any later turn, whose path
  is in `cleared_paths` — isomorphic to `compacted_path_re_reads`. Consumed by
  the FP-1 (a) detector at the SAME entry point as `compacted_path_re_reads`,
  side-by-side, never merged into one blended count (design §7).
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

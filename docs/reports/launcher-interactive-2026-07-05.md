# Launcher Test — Interactive Round (live DeepSeek key) — 2026-07-05

Follow-up to `launcher-test-2026-07-05.md`. Executed manually via the loop
(Code session issues prompts → human runs them in a live `ecode`/pi TUI → Code
session reads paste-backs and verifies the filesystem side directly). This is
the "下一轮 loop" the round-1 Cowork retrospective defined: T9 补测 (real key) +
interactive extension verification (round-1 Finding 3 gap).

Session: `ecode` interactive, `deepseek-v4-flash • high`, 1.0M window, extension
`extension.ts` loaded. Real `DEEPSEEK_API_KEY` present (value never read —
presence-only). Ambient dir baseline: 7 files pre-session.

## Results

| Item | Result | Evidence |
| --- | --- | --- |
| T9 real-key round-trip | **PASS** | `What is 17*23?` → `391`; `Say only: banana` → `banana`. Real deepseek-v4-flash answers, no auth error, two live turns. |
| T9 ambient JSONL landing | **PASS** | Session wrote ONE file `019f3196-…jsonl`; grew 464 B (turn 1) → 1409 B (turn 2), mtime 17:29→17:36. **[dispatcher-verified, filesystem]** |
| `/compact-status` gating readout | **PASS** | Config wired from ecode env: `compactAfterInputTokens=32,000`, `keepRecentAssistantMessages=3`. Gate correct (`16 < 32,000 → waiting`). |
| `/compaction set` takes effect | **PASS** | `set compact-after=10` → ack `32000 -> 10 (takes effect next turn)`; next `/compact-status` shows threshold 10 + gate flips to **active** (`16 >= 10`). Restore `set compact-after=32000` → ack `10 -> 32000`. |
| Compaction trigger path fires | **PASS (no-op, by design)** | After banana turn: gate `active` (`22 >= 10`), Messages 4 / 2-assistant, Protection window 2/2 within keepRecent=3 → **Replacements: 0**. Trigger evaluated; correctly compacts nothing because every message is inside the protection window. |
| Footer renders (T8) | **PASS** | `↑2.6k ↓51 R2.2k CH86.6% $0.000 0.3%/1.0M` — normal, extension loaded. |

**0 FAIL. No fix-forward candidates** — `bin/ecode` and the extension behaved
correctly throughout; the extension's config is correctly sourced from ecode's
env defaults.

## Verification node

Round-1 retrospective's defined node — "T9 PASS 且 interactive 三项有实测记录" —
is **met**: T9 PASS (both halves) + the three interactive items (`/compact-status`
readout, `/compaction set` effect, trigger path) all recorded live above. Also
satisfies protocol §3 condition 2 (T9 单项通过 — minimal reviewable unit). Ready
for Cowork retrospective.

## Findings

**F-A — the gate compares against the compactable message-content estimate, not full input tokens (LOG-ONLY).**
Two different "context" numbers appear in adjacent commands: `/compaction set`
reports `Context ~2,288 / ~2,550 tokens` (full window), while `/compact-status`
reports `Context estimate: raw ~16 / ~22 tokens` and **the gate uses the latter**
(`16 >= 10`, `22 >= 10`). So `compactAfterInputTokens` (default 32,000) gates on
the compaction algorithm's *compactable message-list* estimate, not total input
tokens. Architecturally defensible (only message content is compactable), but the
name plus the ~100× gap between the two displayed numbers can mislead DF0 tuning
("set 32000" ≠ "fires at 32k of context-window usage"). Naming/observability,
borderline design → log-only. Options: doc note on what the threshold measures,
or surface both numbers together.

**F-B — first clean with-extension cache reading is `CH86.6%`, but it is DeepSeek NATIVE cache, not extension effect.**
Footer `CH86.6%` at ~2.5k context. The extension did **0 replacements / 0 tokens
saved** this round, so 86.6% is pure DeepSeek native prefix caching — consistent
with round-1 Finding 1's data-correction (the earlier `CH95.4%` was also native,
sans extension). Record as native-cache evidence only; do NOT attribute to the
compaction extension.

**F-C — ambient accumulation model clarified (refines round-1 log-only #1).**
One JSONL file per `ecode` *invocation* (per session); that single file **grows
across turns** within the session (464 B → 1409 B here), not one file per turn.
So Cowork ruling #1 ("one file per invocation, unbounded") is exact — unbounded
in file *count* = number of launches. Retention decision unchanged (revisit with
DF0 volume).

**F-D — reasoning leakage in TUI output (misc, not ecode's fault).**
`deepseek-v4-flash • high` emits visible chain-of-thought before the final answer
even when asked to reply with only X (`Let me compute…`, `but I think this is a
test…`). Model/effort behavior, not the launcher. "high" effort is shown in the
footer; `bin/ecode` sets no effort flag (pi/provider default). Potential DF0
output noise — note only.

## Round 3 — real compaction savings (Replacements > 0)

Forced the savings path: `set compact-after=10` (gate armed) → agent read
`docs/loop-protocol.md` (a real `read` tool_result enters history) → three short
turns push it past the keepRecent=3 protection window.

| Item | Result | Evidence |
| --- | --- | --- |
| Trigger marker line (Finding 3 "触发标记线") | **PASS** | Live in-session: `[compaction fired] turn 9 \| 1 replacement(s) \| ~291 tokens saved \| gate 3,808/10`. Emitted via `pi.appendEntry` as a custom entry (extension.ts:271), never a mid-stream sendMessage. |
| Real `Replacements > 0` + savings | **PASS** | `/compact-status`: Replacements 1 (1 read), raw ~505 → compacted ~214, effective saved ~291 (**58%**). First demonstration the extension actually saves tokens on pi+deepseek. |
| `/compact-diff` | **PASS** | `turn 5 tool_result: read …/loop-protocol.md -- raw ~329 tok -> summary ~38 tok (saved ~291)` — degraded-path summary (path + est.), per G1b. |

**F-A — RESOLVED at source (was "confusing", now a semantics note, not a bug).**
The gate compares `estimateAgentTokens(messages)` (the message-list "raw" estimate)
against `compactAfterInputTokens` — `projection.ts:86-87` — deliberately, to keep
the prefix cache byte-stable until the message body itself is worth compacting
(`projection.ts:18-21`, "hybrid gating"). So `compact-after=32000` means "32k of
compactable message content", NOT "32k of context-window usage" (the `~2,288` /
footer number). The marker's `3,808` and status's `505` are the SAME measure
(`outcome.rawTokens`, fed to both — extension.ts:276) at different moments: the
marker fires pre-compaction with the turn's transient deepseek reasoning tokens
counted; by the `/compact-status` query those reasoning blocks have evaporated,
leaving ~505. **New nuance (paper/DF0):** a high-reasoning model transiently
inflates the gate estimate at fire-time — compaction can trip on reasoning bloat
that then disappears. **Cowork ruling (2026-07-05):** keep the semantics (only
message content is compactable — gating on it is correct), but two adjacent
commands showing scales ~100x apart is a DF0 landmine → **fix-forward: label the
scales distinctly** — `compactable-content` on the gate line + `set` ack, `total`
on the context readout; no semantic change. Implemented (observability.ts gate
line + extension.ts set-ack; 38/38 extension tests green). The reasoning-inflation
nuance stays log-only (excluding in-flight reasoning from the gate is a design call).

**F-E — relative-path reads resolve under the pi package dir, not the project root (LOG-ONLY, DF0 friction).**
`Read docs/loop-protocol.md` → `ENOENT … /pi/packages/coding-agent/docs/loop-protocol.md`;
the agent self-recovered via `find` + absolute path, then read + answered correctly
(`5`). pi's read resolves via `resolveToCwd(path, cwd)` (read.ts:124) with `cwd`
seeded from `process.cwd()` at startup (startup-ui.ts:69), yet runtime resolution
anchored to the coding-agent package root — pi appears to re-anchor the session cwd
to its own package rather than the user's `~/Projects/ecode`. No `--cwd`/`--project`
CLI flag found for ecode to override. Can't patch `pi/` (hard zone). Real daily
friction: every relative read fails first try. Options: (a) confirm the mechanism
with a pi-side trace, (b) find a pi flag/env to pin session cwd, (c) document
"reads are cwd-relative to the package root; use absolute paths" until upstream.

## Handoff / git

- Round-1 retrospective (Fable) was **staged but uncommitted** on
  `launcher-test-2026-07-05.md` while this was written. Recommended commit order:
  (1) that retrospective, (2) this interactive-round report. This file does not
  touch the staged one; commit each with an explicit pathspec (not `git add -A`)
  to keep them as separate one-thing commits.
- Fix-forward: F-A label fix (relabel the two token scales, no semantic change)
  per Cowork ruling — observability.ts + extension.ts. F-E stays pi-side/log-only.
- Log-only: F-A (threshold semantics), F-E (relative-read base) — F-C / F-D are
  records. None blocking.

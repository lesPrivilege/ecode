# Systematics of Context Pruning: Deterministic Replicas of Frontier Mechanisms as Thin-Harness Extensions

> Working paper draft (EN, primary), 2026-07-08. Chinese translation:
> `paper-pruning-replica-2026-07-08_zh.md`.
> Status: all methods and engineering facts below are landed and verifiable
> (G4 series; `pi/` upstream at zero diff). The controlled measurements
> (EXP-TRC-*) are pre-registered and NOT yet executed — this paper contains
> no TRC cost/quality numbers; wherever measurement is discussed, it is a
> pre-registered hypothesis and labeled as such.
> Companion paper: *The Externalization Ceiling and the Cross-Layer Cache
> Contract* (paper-context-economy, which does carry controlled data). This
> paper is the second instantiation of its methodology — the object of study
> switches from home-grown mechanisms to frontier ones.

## Abstract

The coding-agent ecosystem has accumulated an entire layer of "context
pruning" machinery: Anthropic's server-side context editing and compaction,
OpenAI/Codex's compact endpoint and local compaction paths, Claude Code's
multi-tier pre-request pipeline. Public materials enumerate the WHAT
thoroughly, while three dimensions that actually decide selection are
systematically absent: **cache price** (the shape of prefix-cache damage when
a mechanism fires), **reproducibility** (same input, same output; auditable
after the fact), and **failure fingerprint** (which behavioral failure class
a mechanism induces, and whether it is mechanically detectable from
telemetry). This paper proposes and instantiates a method: **deterministically
replicate** frontier mechanisms as thin-harness extensions — runnable and
pluggable on providers that lack the capability (e.g. DeepSeek), sharable of
a test rig with home-grown mechanisms — then measure everything on one
three-column ledger. The first replica target is Anthropic's
`clear_tool_uses_20250919`. The replication process itself yielded a set of
methodological artifacts — a fidelity contract, a divergence ledger, evidence
grades, an official-behavior probe — and one piece of spec archaeology: the
same-named client-side implementation in LangChain contradicts officially
documented semantics.

## 1. The Problem: Taxonomy Stops at WHAT

A focused survey of Claude / Codex public materials and source code
(14 mechanisms, official-documentation-grade citations) shows "context
pruning" is not one thing but a tiered menu: full LLM summary replacement,
remote opaque compact windows, send-time projection, tool result clearing,
thinking clearing, subagent isolation, initial-context re-injection,
provider/model-forked compaction. The real differences among these forms are
not in feature descriptions but in: **does it rewrite history; does it touch
only the send-time view; does it break the cache; is the summary
LLM-generated; is it auditable**.

The industry has begun writing one of these columns into its parameter
surface: Anthropic's `clear_at_least` is officially documented as a knob that
"helps determine if context clearing is worth breaking your prompt cache" —
the first time cache breakage appears as an explicit configuration variable
of a mechanism. But no public work has measured a curve for any of these
parameters. That is the gap this program occupies.

## 2. Method: the Replication Pipeline and the Divergence Ledger

### 2.1 Structural precondition: send-time isomorphism

Anthropic's context editing is server-side, but its contract has one key
property: **the client's history remains complete and unmodified** — edits
happen only before the prompt reaches the model. This is structurally
isomorphic to a thin harness's send-time projection (a context hook that
alters only the outgoing view while the session history persists
byte-for-byte). Moreover, the server recomputes the cleared set from the full
history on every request — mathematically the mechanism already is a pure
function `(messages, config) → messages'`. **The replica is not an
approximation; it is an isomorph**: a deterministic client-side pure function
can replicate it semantics-by-semantics.

### 2.2 The pipeline (six steps, walked end-to-end once)

```
spec verification (official docs + SDK type surface + prior-replica comparison)
→ divergence ledger + evidence grades
→ pure-function package (zero harness deps, golden-fixture TDD)
→ thin adapter (zero harness diff, real-loop smoke + on-disk verification)
→ telemetry + fingerprint wiring (schema strictly additive)
→ three-column-ledger measurement (pre-registered; runs gated separately)
```

### 2.3 Fidelity contract and divergence ledger

Replication discipline: parameter surface, defaults, clearing order match
the official spec 1:1; wherever the spec is silent, every choice tilts toward
byte-stability and determinism, and **every deviation is entered in a
divergence ledger** (here D1–D11), each row carrying a status: structural
divergence (e.g. no true tokenizer client-side), *adjudicated (presumed)*
(a pinned choice where the spec is silent), or *verified* (confirmed against
official behavior). The upgrade path from presumed to verified is a
**zero-sampling-cost probe**: Anthropic's token counting endpoint supports
`context_management` and burns no inference budget; with synthetic
transcripts of known sizes, the `original_input_tokens → input_tokens` delta
yields a binary readout of the true behavior at each silent spot
(PROBE-TRC P1–P3, designed and pending execution).

### 2.4 Why evidence grades are necessary: replica drift in the wild

The evidence round found that LangChain's `ClearToolUsesEdit` (self-described
as "Mirrors Anthropic's context editing capabilities") already deviates on
**documented** semantics: it implements `clear_at_least` as a
"stop-once-enough-is-cleared" budget, while the official text specifies an
all-or-nothing applicability gate (if the minimum cannot be cleared, the
strategy is not applied at all). One direct corollary: a prior replica's
choices at spec-silent spots can only count as weak evidence — it drifted
even where the text is explicit. Replica drift in the public ecosystem is
not an isolated bug; it is the systematic consequence of lacking a
divergence-ledger discipline, and it happens to be this method's natural
negative control.

A spec increment found along the way: the official TypeScript SDK types
declare `clear_tool_inputs` as `boolean | Array<string>` (the docs page says
only boolean) — the SDK type surface is stricter than the prose docs, and
verification must cover both.

## 3. Case Study: Replicating clear_tool_uses (G4 series, landed)

### 3.1 Implementation facts

- `@ecode/context-pruning`: pure-function package, zero harness/provider
  dependencies, 23 golden-fixture tests. All three identity paths (below
  trigger / empty clearable set / clearAtLeast unmet) return **the original
  array reference** — the prefix-cache contract holds by construction;
  idempotence and byte-stability under monotone transcript growth are
  fixture-anchored.
- `extensions/frontier-pruning`: a thin pi adapter, 31 tests, including a
  real agent-loop smoke — real tool execution, the send payload carries the
  placeholder while the on-disk session JSONL retains the full original
  bytes (asserted in both directions: originals present on disk + zero
  placeholder occurrences on disk). The upstream fork stays at zero diff
  throughout.
- Telemetry: runs of arm T (the mechanism standing alone) emit JSONL rows
  carrying `trc:{applied, clearedToolUses, clearedInputTokensEst,
  gateReading}` and `cleared_path_re_reads` (parallel and isomorphic to the
  home-grown projection's `compacted_path_re_reads`, never merged), consumed
  directly by the failure-fingerprint detectors.

### 3.2 Two engineering invariants (transferable lessons)

**Decouple the gate variable from the gated action.** Earlier, on the
home-grown projection, we measured gate self-pollution in the field: once
the gate reading incorporated provider usage feedback, the projection action
depressed the next turn's reading, producing a period-2
projection/identity oscillation (corpus-wide; low-threshold 8k runs are the
counter-proof that confirms the mechanism). The replica therefore mandates:
the trigger reading is computed by an injected monotone estimator over the
raw transcript, never reads usage-like fields, and carries a negative test
(mutate usage fields; assert the gate reading does not move). This is a
structural divergence from the official server-side true-tokenizer count
(D2), entered honestly: the client has no free tokenizer ground truth; gate
units only need self-consistency, and monotonicity matters more than
accuracy.

**An identity contract as a load-bearing cross-layer structure.** The
adapter's write-back detection uses no markers at all — only the core
package's identity contract: untouched messages return as the same object
reference, so `projected[i] !== original[i]` is a complete criterion for
"this message was cleared". That contract was then explicitly pinned into
the core package's test surface — once an implementation property becomes
load-bearing downstream, it is promoted from implementation detail to
contract, and must have a guard test.

### 3.3 Form contrast with the home-grown mechanism (falsifiable, pre-registered)

The home-grown seam-A projection performs **structured summarization**
(preserving path, line counts, head/tail); TRC performs **whole-result
clearing** (placeholder left behind; under default config the path survives
via the paired toolCall arguments, and with `clear_tool_inputs=true` even
the path disappears). Hence the pre-registrations:

- **H1**: at equal token savings, TRC induces more class-(a) information-gap
  re-reads (re-reads of cleared paths) than structured summarization — the
  facts a summary preserves reduce the need to re-read;
- **H2**: TRC's near-tail cache-break rhythm is isomorphic to the home-grown
  projection's age-boundary tax (one pair ages out of the keep window per
  turn); `clear_at_least` contributes only a one-time step at the activation
  edge;
- **H3** (structural — needs no run): TRC has no summarization step, so the
  class-(b) summary-defect fingerprint is structurally inapplicable to it —
  **a whole-clearing mechanism trades away (b) risk for (a) risk**. This is
  the first ledger cell fillable without an experiment: it follows directly
  from the mechanism's construction.

Corresponding experiments: EXP-TRC-1 (three-arm contrast), EXP-TRC-2
(`clear_at_least` ∈ {0, 5k, 20k} price sweep — the first measured curve for
that parameter), EXP-TRC-3 (`clear_tool_inputs` strong contrast;
prerequisite debt: an independent count of dead-path clears). All
pre-registered, pending execution, queued behind the existing experiment
schedule.

## 4. Honest Boundaries

- Zero TRC measurement numbers in this paper; everything in §3.3 is a
  pre-registered hypothesis whose direction may be refuted;
- divergence-ledger rows D4/D5 (error-result clearability; excludeTools vs
  the keep quota) are currently *adjudicated (presumed)* and must not be
  cited as official behavior until the probe runs;
- single harness (pi), single provider family
  (OpenAI-compatible/DeepSeek); the estimator unit is an estimate, not true
  tokens (D2/D6) — comparable across runs, not across tokenizers;
- the LangChain comparison is a source reading of its current
  `context_editing.py`; if upstream fixes it, the corresponding passages
  should be updated (the finding itself remains true as a point-in-time
  fact).

## 5. The Program View

This case is the first frontier batch (B1) of the "systematics of context
pruning" program. Under the full mechanism inventory × feasibility matrix,
the next replicable batches are, in order: thinking clearing (a data
position unique to the DeepSeek reasoner setting; prerequisite verification
of the provider's reasoning-replay rules), initial-context re-injection, and
cache-aware pinning (prerequisite: reconciling telemetry units). The
structurally non-replicable cells (remote opaque compaction, subagent
isolation) convert into behavior probes, upstream issues, and a
failure-economics case library. End-state outputs: a cross-mechanism
comparison chapter (merged into paper-context-economy v2), a plugin suite,
and upstream contributions.

## Internal Grounding (file-level; replace with pinned repo links on release)

`docs/arch-frontier-pruning-design-2026-07-08.md` (spec, rulings, divergence
ledger D1–D11, PROBE-TRC); `docs/g4-frontier-pruning-packets-2026-07-08.md`
(full acceptance record of the three packets);
`docs/program-context-pruning-2026-07-08.md` (mechanism matrix and batches);
`docs/note-projection-turn-variables-2026-07-08.md` (gate self-pollution
measurement); `docs/note-landscape-compaction.md` (the 14-mechanism survey
and the taxonomy→economics table); `packages/context-pruning/`,
`extensions/frontier-pruning/`, `experiments/` (implementation and tests).

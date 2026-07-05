# DF0 — Compaction TUI Dashboard (design)

2026-07-05. First DF0 build task. Purpose: make the **net-save ledger** — the thing
DF0 measures — visible live while dogfooding, instead of typing `/compact-status`.
Feasibility scanned (loop 1): pi's extension UI API supports it with **no `pi/`
changes**.

## Design (approved shape)

Two layered surfaces, both fed by ambient telemetry + the seam-A projection
(observe-only — no knobs):

1. **Always-on strip** — `ctx.ui.setWidget`, one line between chat and editor:
   `⟨compaction⟩ gate 21k/32k waiting · last −291 (58%) · net today +4.2k · CH 93%`
2. **On-demand ledger** — `ctx.ui.custom()` behind `/compact-dash`: full overlay,
   per-trigger table (turn, saved, cache-break, net, CH% dip), running net, CH% trace.

Surfaces confirmed in the loop-1 scan (`setWidget` types.ts:184 /
interactive-mode.ts:1957; `custom()` types.ts:231 / interactive-mode.ts:2368).
Ruled out & unneeded: sidebars, split panes, persistent-background components.

## Data

- **`saved`** per trigger: clean — compaction-core reports raw→compacted.
- **`cache-break`** per trigger: the hard number — the CH% dip after a prefix
  rewrite, converted to re-paid tokens × price. **Methodology is a user judgment
  call, decided at L4** (options presented then). DF0 is magnitude-first, so a
  rough estimate is acceptable.
- **net = saved − cache-break.** All derivable from the ambient JSONL
  (`sentInputTokens`, `projectedThisTurn`, `compactedReadPaths`, cache) — no new
  instrumentation, which keeps it observe-only by construction.

## Build loops (weak base model → small increments)

- **L2** — `setWidget` strip, LIVE GATE LINE only (holder updated by the seam-A hook).
- **L3** — enrich the strip: last replacement (saved / %) + CH%.
- **L4** — net-save computation (needs the cache-break decision) → running net on strip.
- **L5** — `custom()` overlay `/compact-dash`: full ledger table + CH% trace.

Retrospect each loop; once L4 lands, each real trigger also yields a ledger sample.
Snapshot build / 12-run can run in parallel.

## Disciplines

Observe-don't-intervene — the strip is read-only; never tune a knob to "improve" a
number. DF0 numbers are anecdotal — never paper main-text; the causal net-save
verdict is G2's.

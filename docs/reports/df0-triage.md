# DF0 Triage Corpus — re-read / confirmation pathologies

2026-07-05. Categorized samples of token-loss behavior observed while dogfooding
`ecode`. Feeds `note-view-based-context.md` (intent declaration + semantic ledger +
trust protocol) and the net-save question. Advance-the-seed trigger: **≥5 clean
entries.**

## Taxonomy

- **(a) compaction-driven re-read** — model re-reads a path whose result was
  compacted away. Ambient: `compacted_path_re_reads > 0`. Sub-split (per the seed):
  directed re-read with new intent = normal; undirected full re-read = pathology.
- **(b) summary structural defect** — the compacted summary is malformed/misleading
  and provokes wasted work.
- **(c)** — reserved (pairing / truncation, charter obs #3, or per Cowork's taxonomy).
- **(d) stale-view self-verification spiral** *(new, 2026-07-05)* — the model doubts
  its own successful work after seeing a stale view, and burns turns re-reading
  **available (non-compacted)** content to self-confirm. Not an information gap — a
  **confirmation gap.** Ambient discriminator: `total_re_reads > 0` while
  `compacted_path_re_reads ≈ 0` (re-reading content compaction did NOT remove), plus
  low CH% (varied re-reads break the prefix cache) and high reasoning tokens.

## Entries

### (d)-1 — L3-redo build session `019f3223` — 2026-07-05

Task: enrich the gate strip. **Succeeded** (fence held — 0 `pi/` edits, 38 extension
tests pass). But the *process* spiralled:

- ambient: 34 turns, **19 reads / 12 re-reads**, **`compacted_path_re_reads = 0`**
  (proj only 2), CH **37.9%**, reasoning **~591k**.
- 12 re-reads with ≈0 compaction cause ⇒ re-reading available content to
  self-confirm. Clean **(d)**: confirmation-seeking, not information-recovery.

Design implication (per the seed's trust protocol): the fix is a mechanically
verifiable causal anchor, never reassurance — edit results kept incompressible
(`path + new hash + diffstat`), views tagged with birth-hash, and a one-line
mismatch hint ("this view predates your turn-N edit, hash X→Y; re-read if you need
the new content"). taucode's hashline is thereby reframed as **cognitive
infrastructure**; pi's `read` lacks a hash (G0 survey Item 1) → this spiral is the
direct cost of that gap.

**Priority note:** if (d) recurs, the trust-protocol slice (edit-result preservation
+ one-line mismatch hint) is smaller than the full ledger and independently testable
— (d)-rate before/after is its own effect proof. It can ship ahead of the ledger.

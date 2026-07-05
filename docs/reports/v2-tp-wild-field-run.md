# V2-TP Wild Field First Run — Report for Fable Review

2026-07-05. Flag-on validation against DeepSeek v4-flash in a live DF0 session.

## Protocol

- Extension: `deterministic-compaction` with `ECODE_TRUST_PROTOCOL=1`
- Model: DeepSeek v4-flash (via pi, standard DF0 routing)
- Operator: human runs prompts in a separate df terminal; Opus session analyzes returns
- Goal: confirm stale-view hints fire correctly, prefix cache remains stable, model exhibits correct temporal reasoning when hints are present

## Round Summary

### Round 1 — Baseline edit (no stale read in context)

**Prompt**: Simple file edit + question about old content.

**Result**: Model read → edited → answered from memory without re-reading. CH 96.0%.

**Analysis**: No stale-view hint fired because the read result had already scrolled out of the context window (compaction ate it). This is correct behavior — no false positive. Establishes that flag-on does NOT inject spurious hints when no stale reads are present.

### Round 2 — Flag confirmation

Ambient JSONL from prior sessions showed `trust_protocol_enabled: false` (those sessions predated the env export). Confirmed `echo $ECODE_TRUST_PROTOCOL` = 1 in the active df terminal. Proceeded.

### Round 3 — Hint fires, model obeys (decisive)

**Prompt**: Read a config file, edit it (changing delimiter from comma to slash), then ask "what format is it in now?" — designed so the stale read remains in context.

**Result**: Model saw the `[stale-view]` hint in its context. Immediately re-read the file. Answered correctly ("slash-separated format"). CH unchanged (no cache break from volatile tail append).

**Significance**: This is the core V2-TP success criterion. The model:
1. Received the hint as a trailing volatile message (not persisted, not breaking prefix)
2. Recognized it as actionable (re-read instead of answering from stale memory)
3. Produced the correct answer based on fresh file state

### Round 4 — Multi-file stress (decisive)

**Prompt**: Rename exports across 3 files, then ask about current state of each — designed to produce multiple simultaneous stale-view hints with different turn numbers and hashes.

**Result**: Model saw hints for all 3 files at different points. Correctly:
- Distinguished "stale because another file's edit changed this file" (cross-turn) from "stale because I just edited it" (own-edit)
- Re-read only the files where its view was genuinely outdated
- Did NOT re-read files where it was the last editor (hash matched)
- CH 90.7% — the 9% drop is from the additional re-read tokens, not from cache break

**Significance**: Confirms the hint system works under multi-file concurrency. The model's temporal reasoning correctly interprets turn numbers and hash mismatches.

## Protocol Validation Matrix

| Criterion | Result | Evidence |
| --- | --- | --- |
| Hint fires on genuine stale read | PASS | R3: hint appeared, model re-read |
| No false positive when view is current | PASS | R1: no hint on compacted-away read; R4: no re-read when model was last editor |
| Prefix cache stability (CH not degraded by hint) | PASS | R3 CH stable; R4 CH 90.7% (drop = extra tokens, not cache break) |
| Model exhibits correct temporal reasoning | PASS | R4: multi-file differentiation of cross-turn vs own-edit |
| Volatile tail not persisted | PASS | Subsequent turns do not re-surface old hints |
| Multiple simultaneous hints | PASS | R4: 3 files, different turn numbers, all correct |

## Test Suite Confirmation

After field run, all test mutations introduced during data collection were reverted:

```
Test Files  14 passed (14)
Tests       73 passed (73)
Duration    2.48s
```

Working tree clean (extension directory). No code changes from the field run persist.

## Conclusions

1. **V2-TP is functionally correct** under live conditions with a production-tier reasoning model.
2. **The volatile tail append design is sound** — hints influence model behavior without breaking the prefix cache or persisting across turns.
3. **The model's response to hints is exactly as designed**: re-read when stale, skip when current. No over-reading (which would waste tokens) or under-reading (which would produce stale answers).
4. **DeepSeek v4-flash's temporal reasoning is adequate** for interpreting hash-based stale-view hints — it correctly parses turn numbers and distinguishes self-edits from cross-edits.

## Recommendation

V2-TP is ready for G2 round-2 (flag-on C' arm). Critical path remains **G2 round 1** (flag-off baseline): needs API keys + task snapshots + 12 runs to establish the control group before the flag-on comparison can proceed.

No further V2-TP code changes are needed until round-1 data lands.

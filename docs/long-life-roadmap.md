# Long Life Roadmap

2026-07-06. This roadmap starts after R2: the project has real DeepSeek data,
artifact retention, deterministic compaction, trust hints, semantic anchors behind
flags, and a first dispatch policy. The goal now is to keep ecode useful after the
current model quirks and job-application window have aged out.

## North Star

ecode should become a small, durable harness for measuring where context should
be handled by rules, by models, or by provider infrastructure.

The durable asset is not one compaction trick. It is the combination of:

- byte-stable context transforms;
- filesystem-backed provenance;
- provider cache telemetry;
- task-type dispatch rules;
- negative-result discipline;
- artifacts that let humans audit what the agent actually did.

## Product Shape

**Research rig first.** Keep the repository optimized for controlled runs,
reviewable artifacts, and falsifiable reports. Do not turn it into a general
agent framework.

**Plugin second.** Publish the reusable pieces only after the local rig can
explain them: `@ecode/compaction-core`, the pi extension, and a minimal launcher
profile. The plugin should be boring to install and easy to disable.

**Narrative third.** The public story should lead with context quality and
observability. Cost claims are allowed only where paired data and artifact review
support them.

## Horizons

### H0 — Close The Current Loop

- Land the current evidence bundle: `r2-verdict`, evidence index, README, and
  release-path note agree on the same state.
- Run the approved sweep: R1-C at 4k/16k/64k and D1-C at 4k.
- Run E1 x C'' with `ECODE_SEMANTIC_ANCHOR=1`.
- Update `note-release-paths.md` from seed to final release decision.
- Open upstream issue candidates only after the evidence pages are stable:
  settings persistence, cache diagnostics, and extension capability gaps.

### H1 — Make The Measurements Boring

- Add a one-command local audit that scans JSONL structure, provider errors,
  flags, manifest hashes, acceptance rows, artifacts, and cache signal presence.
- Promote the R2 turn-interaction retro
  (`docs/reports/r2-turn-interaction-retro-2026-07-06.md`) into the template for
  future post-run analysis: harness action, provider action, failure turn, and
  interaction fix.
- Keep every real run reproducible from a manifest: packet id, arm, threshold,
  workspace hash, provider, model, and env flags.
- Promote artifact review into a standard report section, not an appendix.
- Add golden fixtures for the known failure classes: information gap, summary
  defect, loop pathology, and confirmation spiral.

### H2 — Dispatch Policy

- Turn the R2 strategy table into explicit policy:
  refactor/code-production -> deterministic projection;
  exploration/completion-first -> checkpoint or semantic anchor;
  direct-transform -> baseline unless stronger negative probes fail.
- Test policy decisions on held-out packets before any automatic runtime switch.
- Keep manual override first-class. The policy is a recommendation layer until
  it survives multiple task families.

### H3 — Context Protocols

- Finish semantic anchors as the cheap alternative to checkpoint summaries.
- Evaluate LLM-declared work-semantics sidecars only after C'':
  `docs/reports/llm-declared-work-semantics-2026-07-06.md`.
- Keep the implementation decoupled by extracting semantic events, a unified
  ledger, declaration parsing, projection policy, and renderers:
  `docs/reports/extension-work-semantics-architecture-2026-07-06.md`.
- Add read-summary symbol extraction as a separate packet, limited to TypeScript
  first.
- Evaluate view-based context only when a task shows useful disposable/semantic/
  verbatim intent separation.
- Keep trust hints mechanical: hashes, turns, paths, diffstats. Never inject
  confidence as prose.

### H4 — Provider Contract

- Treat DeepSeek as the primary cache-observable backend.
- Ask providers for cache boundary diagnostics before asking for smarter
  summarization: prefix break offset, cached span ids, and compaction visibility.
- Keep OpenAI-compatible support as a portability check, not the core thesis.
- If server-side compaction appears, compare it as another arm instead of
  rewriting the local thesis around it.

### H5 — Public Release

- Release path A when install friction is low and tests are green from a fresh
  checkout: core package + pi extension + launcher docs.
- Release path B only with bounded language:
  "On refactor/code-production tasks, deterministic projection reached comparable
  acceptance at about one third cost in this n=3 DeepSeek/pi setup."
- Publish failures next to wins. A negative exploration result is part of the
  product: it tells users when not to use the rule.

## Maintenance Rules

- Keep `pi/` upstream-zero-diff unless an upstream PR is the explicit task.
- Keep flags default-off for new mechanisms until one controlled run and one
  artifact review pass.
- Do not let ambient dogfooding replace paired experiments.
- Do not let paired experiments replace human artifact review.
- Archive contaminated runs, but never delete them silently.
- Every new metric needs one sentence saying what decision it changes.

## Next Packet Queue

### 已完成（2026-07-07 收束）

1. ~~`C2-ANCHOR-E1`~~: done. C'' failed D-grade completion gate (2/3 vs 3/3
   placebo); Branch B activated. Cost signal preserved (E1 cheapest arm,
   19 turns/538k). Reports: `c2-anchor-e1-2026-07-06.md`,
   `branch-b-e1-2026-07-07.md`, `branch-c-e1-2026-07-07.md`.
2. ~~`WS-0`~~: done 2026-07-06; tool-result semantic events → `semantic-events.ts`.
3. ~~`WS-1`~~: done 2026-07-06; runtime state unified → `semantic-ledger.ts`.
4. ~~`WS-1.5`~~: done 2026-07-06; shared declaration/summary record surface.
5. ~~`WS-2`~~: done 2026-07-06; `declare_work_semantics` capture-only tool.
6. ~~`WS-2.5`~~: done 2026-07-06; declaration tax probe (measurement JSONL).
7. ~~`WS-3`~~: done 2026-07-06; sideband summary records.
8. ~~`WS-4`~~ + ~~`EXP-WS`~~: done 2026-07-06; default-off projection policy
   and addon experiment arms wired.
9. ~~`WS-5`~~: done 2026-07-06; write-only `.ecode/ledger/` sink.

### 待验（有明确触发/门禁）

10. `SWEEP-R2`: R1-C 4k/16k/64k + D1-C 4k, six real runs, same audit as R2.
    门禁：甜点区阈值边界测量。
11. `NUDGE-GOV`: cue + 预算治理（注入上限 / pending 清空即停）。
    触发器：R17 候选，不排期。
12. 更狠负区探针：verbatim 依赖任务——dispatch policy 的 direct-transform 行。
    门禁：现有探针强度下负区未复现，需更强刺激。
13. C''' 校准研究：模型自知程度测量（论文轴，非产品轴）。
    门禁：in-band 声明税数据（R8）已就位，待设计实验。
14. WS-6 续行注入：从 `.ecode/ledger/` 恢复上下文。
    门禁：WS-5 dogfooding 证据 + 持久层 retention 规则。
15. provider compaction E 臂：对比 server-side compaction。
    触发器：cache-observable backend 暴露 compaction API（R6）。

### 待做（非实验）

16. `RELEASE-AUDIT`: fresh checkout, install, test, typecheck, launcher smoke.
17. `UPSTREAM-ISSUES`: write three narrowly scoped upstream issues with repo
    evidence links.
18. `SYMBOL-SUMMARY`: deterministic TypeScript export/function summary for read
    projections.

## Stop Conditions

- If a mechanism reduces tokens but raises artifact failure rate, it stops.
- If a mechanism wins only under a single prompt shape, it stays experimental.
- If a provider feature makes a local rule obsolete, retire the rule and keep the
  evaluation harness.
- If the harness cannot explain a result from its artifacts, rerun before
  interpreting.

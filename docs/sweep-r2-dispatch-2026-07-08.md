# SWEEP-R2 分发包 — Codex 执行（真实 DeepSeek 开销）

2026-07-08，Fable 组装。依据：roadmap 待验 10（已批准）；note-256k 门禁
第 3 条（阈值曲线）。执行者 Codex（可读 terminal，一次跑完）；验收归人。

**六 run 构成（分发时人确认这一解释）**：R1-C × {4k, 16k, 64k} 三个阈值
+ D1-C × 4k + 新鲜基线 R1-A、D1-A 各一（与 R2-core 隔了数日，重跑基线
对照 provider 时段漂移；若人裁定复用 R2-core 基线，删去后两条即四 run）。

**判权保留**：不加臂、不改阈值集合、不重跑失败 run 换参数——任何偏离
先停下问人。结论（曲线怎么读、门禁清没清）不归 Codex。

---

## 给 Codex 的 prompt（整段复制）

```
You are executing SWEEP-R2 for /Users/lesprivilege/Projects/ecode — six real
DeepSeek API runs sweeping the deterministic-compaction threshold. You run
commands in the terminal and record results; you do NOT interpret findings.

## Preflight (all must pass before any paid run)

1. cd /Users/lesprivilege/Projects/ecode/experiments
2. Confirm env: `test -n "$DEEPSEEK_API_KEY" && echo ok` — if missing, STOP
   and ask the operator.
3. `npm test` → expect all green (72+ tests). `npm run typecheck` → clean.
4. Snapshot: `ls snapshots/r2` exists. Verify it is the same snapshot
   R2-core used: compare `workspace.manifestHash` in an existing meta row
   (`head -5 results/r2-core/08-r1-G2-R1-C.jsonl`) against what
   prepare-snapshot records for snapshots/r2 (check its manifest file).
   Mismatch → STOP and report.
5. Scenario ids resolve: `node plan.ts --arms A,C --scenario G2-R1` prints a
   manifest (no provider call). Confirm scenario G2-R1 and G2-D1 both load
   (they come from docs/g2-task-packets.md via lib/packet.ts).
6. Mock smoke (free): run ONE mock arm to verify wiring end-to-end:
     node --import ./lib/register.mjs run.ts --arm C --scenario G2-R1 \
       --provider mock --workspace-from snapshots/r2 \
       --compact-after 16000 --keep-recent 3 \
       --out results/sweep-r2/smoke-mock.jsonl
   Expect a JSONL with meta/turn/summary rows, data_kind marked synthetic.
   Keep the file; it is excluded from analysis by its data_kind.

## Paid runs (6): interleave arms to spread provider-time bias

Run in THIS order, one at a time, waiting for each to finish:

  1) R1-A fresh baseline:
     node --import ./lib/register.mjs run.ts --arm A --scenario G2-R1 \
       --provider deepseek --workspace-from snapshots/r2 \
       --out results/sweep-r2/R1-A-fresh.jsonl
  2) R1-C 16k:
     node --import ./lib/register.mjs run.ts --arm C --scenario G2-R1 \
       --provider deepseek --workspace-from snapshots/r2 \
       --compact-after 16000 --keep-recent 3 \
       --out results/sweep-r2/R1-C-ca16000.jsonl
  3) D1-A fresh baseline:
     node --import ./lib/register.mjs run.ts --arm A --scenario G2-D1 \
       --provider deepseek --workspace-from snapshots/r2 \
       --out results/sweep-r2/D1-A-fresh.jsonl
  4) R1-C 4k:
     ... --arm C --scenario G2-R1 --compact-after 4000 --keep-recent 3 \
       --out results/sweep-r2/R1-C-ca4000.jsonl
  5) D1-C 4k:
     ... --arm C --scenario G2-D1 --compact-after 4000 --keep-recent 3 \
       --out results/sweep-r2/D1-C-ca4000.jsonl
  6) R1-C 64k:
     ... --arm C --scenario G2-R1 --compact-after 64000 --keep-recent 3 \
       --out results/sweep-r2/R1-C-ca64000.jsonl

For each run record wall-clock start/end (date +%T before/after) into
results/sweep-r2/RUN-LOG.md as you go, plus any provider error verbatim.

Error policy: a provider 5xx/timeout mid-run → keep the partial JSONL,
append ".aborted" to its filename, note it in RUN-LOG.md, retry that run
ONCE. A second failure → STOP everything and report. Never delete a JSONL.

## Post-run mechanical checks (no interpretation)

7. Every JSONL has exactly one meta row, one summary row, turn rows, and an
   artifact row; `cache_signal_present: true` in each summary (deepseek).
   Artifact dirs exist next to each JSONL (results/sweep-r2/<name>/artifact).
8. Gates: node --import ./lib/register.mjs compare.ts \
     --in results/sweep-r2/R1-A-fresh.jsonl \
     --in results/sweep-r2/R1-C-ca4000.jsonl \
     --in results/sweep-r2/R1-C-ca16000.jsonl \
     --in results/sweep-r2/R1-C-ca64000.jsonl \
     --baseline A --json > results/sweep-r2/compare-R1.json
   And the D1 pair likewise into compare-D1.json.
   If any C run shows the `invalid` gate (projected_turn_count=0 — e.g.
   64k threshold never crossed): that IS a result; record it, do NOT
   re-run with different parameters.
9. Write results/sweep-r2/REPORT.md: one table (run | arm | threshold |
   turns | total input | total output | re_reads | compacted_path_re_reads |
   cacheRead total | accept rows pass/fail | gate flags), the RUN-LOG,
   and NOTHING else — no conclusions, no savings percentages.

## Fences

- Do not modify ANY code (extension, compaction-core, experiments, pi/).
  SWEEP measures the frozen v1 mechanism as-is — including its known
  gate-oscillation behavior; that is part of what is being measured.
- Do not touch snapshots/ content; --workspace-from copies it per run.
- Do not create or edit task packets; scenarios come from
  docs/g2-task-packets.md as-is.
- Budget: exactly the 6 runs above + at most 1 retry each. No sweeps
  beyond the listed thresholds.
- API key only from env; never echo it, never write it to any file.
- git: you may `git add results/sweep-r2 && git commit` at the very end
  with message "SWEEP-R2: six-run threshold sweep raw data"; do not push.

Final output: paste REPORT.md content + the compare JSON gate lines.
```

---

## 人侧验收清单（Codex 报告回来后）

- [ ] 六 JSONL + artifact 目录齐全，manifestHash 与 R2-core 一致；
- [ ] compare 门输出：invalid/suspicious 逐条过目（64k 若 invalid，
      即「阈值未触发」本身成立——甜点区上界证据，不是失败）；
- [ ] R1-C 4k vs 16k vs 64k 的成本曲线走向 → note-256k 第 3 步措辞升级判定；
- [ ] 盲评捎带：R1-C 4k 与 64k 各抽一个 artifact 人工盲评 → 轨迹×质量
      第二数据点（stage-verdict 待验 7 的门禁）；
- [ ] 曲线可读后：更新 roadmap 待验 10 状态与 stage-verdict 三态表。

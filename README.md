# ecode

一个绑定 DeepSeek 的开源验证台：在最薄的 harness（[pi](https://github.com/badlogic/pi-mono)）
上，把 agent 的 context 管理——compaction、prompt cache、信任协议——做成
**可观测、可复现、可证伪**的实验对象。名字取 *e*：自然对数底，与 pi 相应。

## 命题：编译经济学

Agent loop 的成本里 input 远大于 output（多轮工具调用下 ~100:1），而 input
的单价由 prefix cache 命中率决定（cached ≈ 0.1× uncached）。于是 context
管理有两种做法，对应两种经济学：

- **解释执行**：让模型（或另一个模型）在运行时决定留什么、摘什么——
  LLM summarization。每次都付推理费，产出不确定，散文摘要丢 file path
  和精确签名。
- **编译**：把「留什么」写成确定性规则——纯函数投影、hash 溯源、
  byte-stable 恢复。一次写成，零边际推理成本，完全可复现，保真由构造
  保证而非优化得来。

coding 变 cheap 的真正后果不是「一切都上 agent 推理」，而是**规则变
cheap**——agent 帮你把规则写出来，规则跑起来不再需要 agent。本 repo
的全部机制（compaction 投影、stale-view 提示、工作语义锚点、判定门、
artifact 留存）都是由多个 agent 以 TDD 写成、以确定性方式运行的机器。
问题不是「规则还是模型」，是**边界画在哪**——这条边界只能靠受控实验
测出来，不能靠信念画。

## 上游视角：不随权重折旧的层

Harness 工程的大部分是对当代模型缺陷的补偿，模型一升级就作废。本 repo
刻意只沉淀**不折旧的东西**：锚定在物理约束（memory bandwidth → prefix
cache 按字节匹配）与文件系统持久性（hash 溯源）上的机制；以及把折旧
本身变成信号的观测面——失效按行为指纹分类（信息缺口 / 摘要缺陷 /
循环病理 / 确证螺旋），每类在 telemetry 里机械可判。对模型方，这套
分类学是现成的训练信号与能力等高线；对下游，它是选型判据。
理论骨架见 working paper《外化天花板与跨层 cache 契约》；对外预览：
https://lesprivilege.github.io/ecode/

## 已实证（受控数据，真实 DeepSeek API）

- **Cache transition 曲线首次受控观测**：确定性投影触发时 cache hit
  下跌、约 10 turn 恢复至稳态以上——byte-stable 恢复性质成立；
  持久化 checkpoint 则造成一次全清后恢复。此前公开领域无此类一手量化。
- **信任协议野外验证**：模型看到 hash 时序锚点（「此视图早于你在
  第 N 轮的编辑」）即停止自我怀疑、精确区分自编辑与跨文件编辑——
  对无状态模型，信任建立在可核对的溯源上，不建立在断言上。
- **R2 终判已落版**：refactor/code-production 类任务中，确定性投影以
  约三分之一成本达到同等 static acceptance，并经 R1-C 三次 artifact
  人工审计确认质量不劣化；exploration 类任务中，hybrid checkpoint
  买到完成率而不是成本优势。完整限定词见 `docs/reports/r2-verdict.md`。
- **诚实的未决**：n=3 只支持方向性判断，不支持显著性宣称；exploration
  的低成本语义锚点 C''、更狠的负区探针、跨模型外推仍待后续轮验证。
  任何未跑过的节省率数字仍然不存在——这是本 repo 的第一纪律。
- **下一步设计入口**：工作语义保护已收敛为「意图声明 + 语义台账 +
  信任协议」的 `path#hash` 契约。extension 解耦评估见
  `docs/reports/extension-work-semantics-architecture-2026-07-06.md`，
  Fable 设计包见 `docs/arch-c3-design-2026-07-06.md`，handoff 链见
  `docs/cowork-fable-index-2026-07-06.md`。

## 布局

| 路径 | 内容 |
| --- | --- |
| `GOALS.md` | 全部工作的切分、分发 packet 与验收记录（入口，先读） |
| `docs/` | 理论笔记、roadmap、实验裁决报告、landscape 核证 |
| `pi/` | 上游 fork（零 diff 纪律，全部改动走 extension） |
| `packages/compaction-core/` | 确定性 compaction 纯函数 + 报告层（零依赖） |
| `extensions/deterministic-compaction/` | pi extension：投影、信任协议、语义锚点、TUI 观测 |
| `experiments/` | 多臂对照 harness：plan / run / compare + artifact 留存 |
| `bin/ecode` | launcher：隔离 profile + env 路由，vanilla pi 为日常对照组 |

## 工作方式

多 agent 分工：packet 自含（精确文件清单 + 验收标准 + 禁区），弱模型
prompt 逐条携带围栏；判权（参数、质量复核、判定门裁决）不下放给任何
agent。校验按风险分级；调研先行，不重复造轮子。协议全文见
`docs/loop-protocol.md`——它本身也是被两次事故修订过的实证产物。

## 判定纪律

- 干净配对 run 之前，任何节省率数字不存在。
- 负区工作流每轮必跑，劣势数据与优势数据同权重收集。
- 阴性结果带完整观测面照常入档：知道边界在哪，和知道怎么赢一样值钱。

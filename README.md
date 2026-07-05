# ecode

context 经济（context economy）验证台。名字取 *e*：自然对数底，与 pi 相应——
本 repo 的核心工作正是在 [pi](https://github.com/badlogic/pi-mono) harness 上
验证确定性 compaction 的经济性。

## 这是什么

taucode（`../taucode/`，只读前身）验证了确定性 send-time compaction 的算法层，
但撞上三面墙：cache 收益轴不可观测、行为假设绑定模型代际、验证基础设施自身折旧
（见 `docs/note-context-economy-three-walls.md`）。ecode 是调伏这三面墙后的重启：
最小实验台面积（pi extension，不 fork core）、可观测性作为选型硬门、
假设降格为被测变量。

## 布局

| 路径 | 内容 | 来源 |
| --- | --- | --- |
| `GOALS.md` | Goal 切分与分发 packet（G0–G2） | 入口，先读 |
| `docs/` | 携带文档（roadmap、三面墙笔记、pi 集成摸底、wrapup、subagent 经济笔记）+ G0 产出的 `g0-survey.md` | 收束自 taucode/docs |
| `pi/` | 上游 fork（G0 建立，保持可追 upstream） | badlogic/pi-mono |
| `packages/compaction-core/` | 解耦后的确定性 compaction 纯函数 + 报告层（G1a） | 移植自 taucode |
| `extensions/deterministic-compaction/` | pi context-hook extension（G1b） | 新写 |
| `experiments/` | 四臂实验 harness：plan / run / compare（G1c） | 新写 |

## 工作方式

每个 Goal 由独立 agent 冷启动执行，packet 自含：精确文件清单 + 验收标准 + 禁区，
禁探索式阅读。判权（参数取值、质量复核、判定门裁决）不下放。
依赖：G0 ‖ G1a → G1b → G1c → G2（执行轮）。

## 判定纪律

- 干净 run 之前，任何节省率数字不存在（尤其「15-17%」）。
- 负区间（direct-transformation 工作流）每轮必跑，劣势数据同权重收集。
- 止损条款见 `docs/roadmap-context-economy-2026-07.md` 第四节。
- 阴性结果带完整观测面照常入档。

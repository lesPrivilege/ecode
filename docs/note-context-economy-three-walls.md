# Note — 下游 context 经济的三面墙：一次实证收束

时间：2026-07-05。性质：对 taucode（2026-05 至 06）与 Mnemos subagent 轮（2026-07）
的失败/未决案例做收束，为「外化天花板与跨层 cache 契约」working paper 提供一手实证段，
也为下一轮 roadmap 提供判准。来源：`compaction-evaluation.md`、`taucode-wrapup-2026-06.md`、
`dogfooding-p0.md`、`taucode-on-pi-integration.md`、`note-subagent-economy.md`。

---

## 一、被收束的对象是什么

taucode 的确定性 send-time compaction 是下游 context 经济在设计上能做到的极限形态之一：

- 纯函数投影（`messages → messages`），JSONL 原始历史不改写，幂等，零 summarizer 成本；
- 三-zone context（字节稳定 ImmutablePrefix / append-only log / 每轮清空 scratchpad）；
- hybrid 阈值门控：`compactAfterInputTokens` 门下原样发送保 prefix cache，跨门才改前缀——
  即在客户端调和「省窗口（压缩派）」与「省 cache（前缀派）」两条互相打架的路线。

它不是玩具：26 个测试用例、报告层、6 工具策略 registry、v1.0.0 已发布。
**收束的结论不是「方案失败」，而是：方案未决，但验证它的经济性先破产了——
而破产的位置全部在算法之外。** 这三个位置本身就是结论。

## 二、三面墙

### 墙一：收益轴不可观测（provider 侧黑箱）

方案的核心收益预期是一条 cache 曲线：compaction 首次触发时 prefix 回落，随后确定性
摘要让压缩区重新字节稳定、cache 恢复（预期 90→15→87 的 transition-plus-steady-state）。
但 Mimo 不报 cache 字段，on/off 两组全为 0——**这条曲线从客户端根本无法观测**，
cache 轴被迫从 P0 撤下。

这是「server 端不可见的 cache 行为，客户端救不了」的度量版：不但救不了，连看都看不见。
下游方案的正确性论证依赖一个自己无权读取的仪表盘。

### 墙二：正确性假设与模型代际绑定

整个投影方案压在 first-reply semantics 假设上：模型用完工具会把关键语义写进下一条
文本回复，故窗口外的原始 args/result 可近乎无损地降格为结构化摘要。

实测的失效形态（2026-05-28 激进 run，`keep=1`+`compact-after=2000`，50 turn）：
input 降 47%，但 **124 次重复读文件**——直接转换型工作流需要精确原文，摘要不够，
模型重读把省下的又吐回去。已知的三种假设失效（silent execute / process-only text /
latent details）全部是特定模型行为分布的函数。**分布一漂，判准全部重标定**——
与 DeepSeek 三层补偿案例同构：可以做到很精，但精是对某一代模型的精。

### 墙三：验证基础设施自身持续折旧

干净的推荐参数 A/B（`keep=3`+`32k`，refactor/exploration 双工作流，人工质量复核）
至今没跑成。卡点链条：小模型（Mimo）无法稳定自改 harness → 靠 codex 监工进度慢 →
决定迁移到 pi → 又是一轮 `Message ↔ AgentMessage` 类型适配 + externalization
三处解耦（strategy registry / tool-name 匹配 / path-hash 提取）。

**移植成本本身就是折旧。** 对照面：pi 原生自带 LLM-summary compaction，
fork pi 等于白拿对照组——下游花一个多月自建的实验台，上游生态里是免费件。

### 补充：第三档位的同类账

`note-subagent-economy.md` 记录了 context 管理三档位之三（subagent 分发）的同型成本：
隔离的价值只在「有污染可防」时兑现（判断密集/高风险提交回本），机械串行任务纯缴
冷启动税（per-frame review 重读几乎相同的文件）。**每条下游 context 经济路线都有
结构性负区间，且负区间的边界由任务分布与模型行为共同决定——两者都不归下游控制。**

## 三、收束判词

三面墙都不是工程瑕疵，是外化天花板的具体形状：

| 墙 | 本质 | 上游为何没有 |
| --- | --- | --- |
| 度量不可见 | 收益轴（cache）在 provider 侧 | server 端 compaction 与 KV cache 同源，全可观测 |
| 假设绑定代际 | 补偿针对当代失败分布 | 失败模式即 RL 反馈源，补偿随训练内化 |
| 验证税 | harness 迁移/自改成本 | 模型、引擎、loop 同阵营，实验台是副产品 |

同一笔工程投入的会计科目差异（下游净损失 / 上游三笔收益），在此从抽象论点
落成逐条可对的实证。写入 working paper 时的准确表述：**「验证成本本身成为
天花板的一部分」**——方案未被证伪，是下游无法以可承受的成本知道它是否成立。

## 四、什么是活的

收束不等于清仓。以下资产与判断仍然成立、可携带进下一轮：

- **compaction 纯函数 + 报告层**：成熟、有测试、近可移植，是 intellectual asset；
- **turn 分类判准**（保留/可压缩/可丢弃）：比「能省 token」更高级的论点，产品能力级；
- **hybrid 门控思想**：客户端调和两条路线的最优已知形态；
- **激进 run 的负面数据**：诚实圈定劣势区间（直接转换型工作流）本身就是可信度;
- **三档位混合模型**（全量压缩 / 动态压缩 / subagent 分发）：Mnemos 轮已粗糙验证分层策略。

下一步见 `roadmap-context-economy-2026-07.md`：三面墙各自的调伏策略与受控实验设计。

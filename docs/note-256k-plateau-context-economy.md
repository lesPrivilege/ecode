# Note — 256K 平台期：context economy 实验的铺垫叙事

2026-07-06 Fable cowork 尾声收录，2026-07-07 数字核验收束。
状态：**叙事结构已证，外部数字已降格**。硬数字（Codex 272K→258K、
needle 掉点百分比、1M vs 256K 2–5x 成本）经核验无法溯源或缺乏强来源，
已删除或改为弱命题。本文不作为独立结论引用；对外口径唯一入口为
`docs/stage-verdict-2026-07.md`。

## 观察（已核验的外部事实）

不是所有模型都技术上卡在 256K；相反，1M context 已开始进入 Codex/Claude
的部分通道（Claude Sonnet 5/Fable 5 官方 1M，Codex GPT-5.4 experimental 1M）。
但 coding agent 的工程实践仍然围绕「有限有效上下文、自动 compaction、
稳定前缀与缓存折扣」展开：

1. 长上下文性能衰减（context rot）：长上下文有效利用并不随窗口线性提升，
   且存在位置/长度衰减。Lost in the Middle 证明相关位置变化显著影响表现；
   Chroma Context Rot 报告称随输入增长普遍观察到性能退化；
2. 工程权衡：预留 auto-compaction 缓冲空间，防 session 爆掉。Claude Code
   官方文档说明接近上限自动 compact；Anthropic API 亦提供 server-side
   context compaction；
3. 成本效率：cached input 约 0.1× base price（OpenAI/Anthropic 当前定价
   均支持）。cached prefix 仍占 context window（Anthropic 文档明确：缓存
   改变付费，不改变是否占窗口）；
4. 训练覆盖：位置编码与训练数据在较短区间优化最充分（行业共识，非定量命题）。

问题不再是窗口能否变大，而是更大窗口下哪些字节值得保留、哪些语义应被
确定性投影、以及缓存断裂税能否被审计。

## 论证结构（三步，各自的证据状态不同）

### 1. 平台期验证的是我们的问题，不是我们的方案

窗口不能无痛变大 → context 是需要管理的稀缺预算 → 「确定性遗忘 + 溯源 +
缓存可测」的生态位是持久的，不是等 1M 普及就消失的过渡方案。
这是 long-life roadmap north star（rules vs models vs provider infra 边界测量）
的外部理由。证据状态：行业行为可观察 + 官方文档支撑，结论稳。

### 2. Context rot 给成本不等式加了第三项

原式（r2-turn-interaction-retro）：

```text
saved payload cost > cache-discontinuity cost + extra-turn cost + re-read cost
```

context rot 证据表明：即使窗口装得下，持有更多原始字节本身劣化推理质量。
所以投影不只省钱，同等能力下可能**更好**。本地证据链已有第一环——
R2 盲评补记副发现：R1-C 的 r2 run 同时是成本最差与质量最差，
「轨迹游荡与代码劣化同向」，轨迹长度可作质量代理。这是我们尺度上的
needle-in-haystack 对应物。

机制表述：工作语义锚点减少漂移 → 缩短轨迹 → 同时改善成本、缓存命中、
产物质量。三者不是三个论点，是同一个机制的三个测量面。
证据状态：本地 n=3 + 一次人工盲评，方向性。

### 3. 优势随窗口变大而变大（假设，未证）

若原始堆积与投影 working set 的差距随任务时长拉宽，则确定性投影的
优势区随窗口尺度增长。我们的数据在 8k–48k 投影阈值，离 256K 两个数量级——
外推是机制上合理的假设，不是结论。第一个检验点已批准：SWEEP-R2
（R1-C 4k/16k/64k）的成本最优阈值曲线走向。

## 成本侧补充

prompt caching 对 agent 成本/延迟有实证收益：2026 论文称跨 OpenAI/Anthropic/
Google，prompt caching 在 agentic benchmark 上降低 API 成本 45–80%、
TTFT 13–31%。社区对「1M 背历史 vs 频繁 compaction」的讨论共识：大窗口
输入开销巨大，compaction tax 虽烦但可控可优化；混合策略（大窗口做规划、
小窗口做迭代）被广泛推荐。

**ecode 对这个共识的修正（这是贡献点，不只是佐证）：**

1. **社区账本漏了缓存折扣。**「每 turn input 高价」按全价计历史债，但稳定
   前缀走 cache hit 只付 ~0.1×。真实对比是「cached 原始历史 vs 压缩后的
   缓存断裂 + 重建」。R2 直接测过这个形状：投影 turn 一次 cacheRead 下探，
   byte-stable 后恢复（19-r3），以及「恢复了也没用因为轨迹语义已死」的
   反例（14-r2）。
2. **compaction tax 应拆三项**：总结生成成本、前缀断裂税、语义丢失引发的
   重读/轨迹税。第三项最贵且最少被讨论——E1 的 0/5 不出现在任何 token
   账单对比里。
3. **「混合策略」= dispatch policy 的民间版。**社区靠手感分派工作负载，
   R2 的任务类型 → 策略映射表是同一直觉的实证版。
4. **尺度定位**：32k–48k 阈值 + DeepSeek 缓存遥测是这套账唯一能逐项审计
   的地方；1M 尺度上 provider 摘要不透明、缓存边界不可见，没人能分解
   compaction tax。小尺度不是缩水验证，是可核验性的选择。

## 与差异化叙事的关系

coding agent 的工程共识是「最小有效上下文 + 稳定前缀 + 自动 compaction」；
但共识的实现全靠不透明摘要。ecode 的差异化从来不是「也做压缩」，而是：
**压缩可审计、遗忘有台账、缓存代价可测量**。平台期让这个差异化有了
持久的外部需求面。

## 命题的最终形式（2026-07-06 收敛）

整个 context economy 实验纲领是一个**存在性命题**，不是普遍性命题：

```text
∃ (工作负载, 阈值)：工作语义保持（completion 不降）∧ 净成本 < 基线
```

- **已有一个证明点**：R1 × 32k（1/3 成本、零 churn、静态 + 盲评双确认）。
  纲领因此是区域测绘，不是赌注：SWEEP-R2 测阈值边界，Branch B 测能否
  延伸到 exploration（语义保持约束咬得最紧处）。
- **收益公式**：投影是前缀换代，不是前缀缩短——阈值下恒等（cache 全吃），
  触发时付一次断裂税换更短的新前缀，靠 byte-stable 使其重新变便宜。
  净收益 = 新前缀每 turn 折扣 × 有效剩余轨迹 − 一次性断裂税。
  语义丢失摧毁的是「有效剩余轨迹」这个乘数——E1 失败 run 里 cache
  恢复了也没用的机制解释。
- **社区痛点即卖点**：「silent cache break」（tool 输出/thinking 块导致的
  静默前缀断裂）被两条纪律排除——恒等路径逐字节不动、投影输出确定性
  渲染（同状态同字节，有测试锚定）。社区共识的终点「大窗口 + 极少聪明
  compaction + 稳定前缀」，机制上就是本项目在可审计尺度做的事。

## 进入公开叙事的门禁

- ~~外部数字逐条核验并附来源~~ → **已完成（2026-07-07）**：硬数字降格，
  弱命题保留，详见本文各节标注；
- 第 2 步的本地证据升级：C2-ANCHOR-E1 落地后，轨迹长度 × 质量的相关性
  至少要有第二个数据点；
- 第 3 步保持「假设」措辞直到 SWEEP-R2 曲线可读。

## Dogfooding usage 记账（2026-07-05/06，DeepSeek 控制台，更新有延迟）

- 07-05：input hit 54.00M / miss 4.87M → 命中率 ~91.7%
- 07-06：input hit 19.05M / miss 3.91M → 命中率 ~83.0%（重实验日，大量投影 transition）

按 DeepSeek 命中 ~0.1× 费率折算，miss 的账单权重 ≈ 10×：07-06 当日 3.91M
miss ≈ 39.1M hit-equivalent，**未命中部分的实际花费约为全部命中部分的 2 倍**。
印证「命中率是第一杠杆」；83% 已低于业界 90% 报警线。
边界：dogfooding + 实验混合流量，只能示意杠杆大小，不作对照数据。

## 可控面陈述（scope claim）

pi 只提供基本 loop——这是特性不是缺陷。frontier agent 的复杂 context 装配
（系统提示、IDE 状态、检索注入、隐藏工具输出）是不可观测的脏数据源，
无法审计。ecode 微调的可控面就是 loop 本身，验证台的外推声明因此有边界：
结论适用于「loop 内 context 经济学」（pi thin loop + DeepSeek 缓存遥测，
8k–48k 投影阈值），不覆盖 loop 外装配、其他模型代际、1M 尺度外推。
这同时是差异化的另一面：可审计性要求可控面收窄。

「工作语义收益 vs 直接买更强模型」是三墙框架的墙二问题：更强模型可能
直接买走 completion 问题，但买不走成本轴（更强模型的 input 更贵，投影的
成本优势与模型无关地存在），且校准指标本身就是跨模型能力测量工具。
两者是互补轴，不是替代品；honest 版本的叙事只主张成本轴 + 测量能力。

## 关联文档

- `docs/stage-verdict-2026-07.md`（对外口径唯一入口）
- `docs/reports/compaction-strategy-research-2026-07-06.md`（landscape 主文）
- `docs/reports/r2-turn-interaction-retro-2026-07-06.md`（成本不等式出处）
- `docs/reports/r2-verdict.md`（盲评补记：轨迹游荡副发现）
- `docs/note-context-economy-three-walls.md`（墙的框架）
- `docs/long-life-roadmap.md`（north star + narrative third 规则）

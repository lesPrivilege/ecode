# Roadmap — context 经济下一轮：三面墙的调伏与测试方案

时间：2026-07-05。前置：`note-context-economy-three-walls.md`（收束判词与活资产清单）。
原则：**不再让验证经济性先于方案破产**——每面墙先给调伏手段，实验才开跑。

---

## 一、三面墙的调伏策略

### 墙一（度量不可见）→ 把可观测性做成硬性选型门

上一轮的错误顺序：先选 provider（Mimo），后发现 cache 轴不可测。翻转为：

- **选型门**：provider 必须报 cache 字段（DeepSeek API 报
  `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`），否则只跑 token 轴、
  cache 结论一律标注「未验证」，不允许预期曲线冒充数据。
- **自建观测面（可选加强）**：本地推理引擎跑同款模型，KV cache 命中/重算完全
  自持——不是为生产，是为把 90→15→87 那条 transition 曲线**直接画出来**。
  下游看不见 server 仪表盘，但可以自己搭一个缩小的。
- 报告层已有 `projectCompaction()` 的 effective savings；补一列 provider 报告的
  cache hit/miss，形成「客户端预期 vs server 实测」双轨对账。

### 墙二（假设绑定代际）→ 把假设降格为被测变量

first-reply semantics 不再作为前提，作为**每次 run 的输出指标**：

- **引用追踪**（上一轮已立项未动，本轮升 P0）：记录每个被压缩 path 是否被后续
  turn 重新 read。`re-read of compacted path` 率就是假设成立度的直接读数——
  也是「可压缩 → 可丢弃」判准升级的唯一证据来源。
- **summary-at-read**：摘要在读取时带意图预付（读的时候就知道为什么读），
  而非驱逐时无方向补产；代码的正确摘要是符号图不是 embedding。作为 C' 臂试点。
- **workload 分层固定化**：refactor / exploration / direct-transformation 三类
  task packet 固定编号，负区间（直接转换型）**必须**在每轮实验里保留一臂——
  劣势区间数据与优势区间数据同权重收集。
- system prompt 强制 post-tool 摘要，作为可开关的补偿项单独计量（它本身
  也是一层会折旧的补偿，要能单独拆除观察）。

### 墙三（验证税）→ 把实验台面积压到最小

- **不 fork core，只写 extension**：pi 的 `context` hook（缝 A）接收
  `AgentMessage[]` 返回投影，正好匹配 taucode 纯函数签名。对上游 diff ≈
  一个扩展目录，上游更新时迁移税≈0。
- **白拿对照组**：pi 原生 compaction 就是 LLM-summary 全量摘要——B 臂免费，
  wrapup 里的 full-compaction TODO 划掉。
- **分工纠错**：上一轮卡死在「小模型自改 harness」。本轮判权分层固定：
  harness/adapter 工作用强模型（claude code / codex）做，小模型（Mimo）只当
  **被试**不当工人；判准与实验设计人工定。
- externalization 三处注入（strategy registry / tool-name 匹配 / path-hash 提取）
  在 adapter 层一次做完，此后策略函数与任何 harness 解耦。

## 二、测试方案（受控四臂）

同一 pi harness、同一 task packets、同一模型，四臂：

| 臂 | 配置 | 验证什么 |
| --- | --- | --- |
| A | 无 compaction（原生关 + 不挂 hook） | 基线 |
| B | pi 原生 LLM-summary | 全量摘要路线（含 summarizer in+out 计费） |
| C | taucode 确定性投影（context hook，hybrid 门控保留） | 核心赌注 |
| D | 混合：门下 C，跨阈值缝 B 落持久 checkpoint | 三档位混合体 |

**指标**（P0 沿用 + 新增）：总 input/output token、completion、re-read 次数、
tool-call 次数、人工质量复核；新增 **compacted-path re-read 率**（墙二读数）、
**provider cache hit/miss**（墙一读数，仅 cache-capable provider）。

**判定门**（沿用 dogfooding-p0 并加严）：

- compaction 未触发 → run 无效（加 turn 或降阈值重跑）；
- token 省但 tool churn / re-read 显著升 → 记为可疑，不进正面证据；
- 质量复核不可比 → token 数字作废；
- **优势区间命题**：长 session、code-production 重、便宜模型下，C 在
  「总 token ↓ 且质量不劣化」上同时赢 A 和 B——三者缺一即命题不成立；
- 阴性结果带完整观测面照常入档：什么都测不出也是结果。

**数字纪律**：47% 是负面案例不是卖点；「15-17%」无出处，在干净 run 重新
确立之前禁止外引。

## 三、阶段路线

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| 0. pi 摸底 | 核对四个待确认项：read 输出格式、extension API 签名、context hook 是否影响持久化、pi-ai 的 cache 字段透传 | 四项全部有答案 |
| 1. 移植 | externalization 三注入 + `Message↔AgentMessage` adapter + context hook extension；复用 `estimateContextTokens` | C 臂在 pi 上跑通一个 trivial packet |
| 2. token 轴 | Mimo 上四臂 paired run（refactor / exploration / direct-transformation），推荐参数 `keep=3`+`32k` + 阈值 sweep 4k/16k/32k/64k | 干净的节省率数字 + 引用追踪读数 |
| 3. cache 轴 | DeepSeek API 重跑 C/D 臂，对账「预期 transition 曲线 vs 实测 hit/miss」 | 墙一首次拿到实测曲线 |
| 4. 判准升级 | 引用追踪数据 → 「可压缩/可丢弃」边界；summary-at-read（C'）试点 | 第二篇笔记素材 |
| 5. 产出 | 数据回填 working paper 实证段；`compaction-evaluation.md` 升级为对外文章（劣势区间诚实入文） | packaging 下游 |

依赖关系：0→1→2 串行；3 可与 4 并行；5 只依赖 2（cache 轴数据到位则增补）。

## 四、止损条款

- 阶段 2 若推荐参数下 C 对 A 无稳定 token 优势（<10%）且 re-read 率不降——
  确定性投影路线归档为「已充分测试的阴性结果」，活资产只保留报告层与
  turn 分类判准，不再投入移植。
- 阶段 3 若实测 cache 曲线显示 steady-state 恢复不成立（压缩区无法重新字节
  稳定）——hybrid 门控假设作废，回退纯「省窗口」叙事。
- 任何阶段发现 pi 上游大版本变更导致 hook 语义变化——记录迁移税工时，
  作为墙三的持续计量数据（这本身是论文素材）。

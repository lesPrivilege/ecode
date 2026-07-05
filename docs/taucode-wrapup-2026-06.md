# taucode 阶段收尾：进度摘要 / 续行-重做方案 / compaction 策略评估

写于 2026-06-22。用途：在 code 中重建 project 前的盘点与决策依据。
本文基于当前 mounted 的 taucode 源码与 docs 实读，不含 picode / reasonix 等外部 repo（未在此环境，相关比较处已标注「待你用本地 repo 补」）。

---

## Part 1 · 进度摘要

### 一句话结论

taucode 不是「只有基础的东西」。compaction 子系统已是一个成熟、有测试、有报告层、近乎可移植的纯函数模块。真正没跑完的不是「写出 compaction」，而是「在优势区间用推荐参数跑出干净、可复现、带人工质量复核的 A/B 数据」。卡点在 harness 的 dogfooding 自改，不在策略本身。

### 已落地（proven / shipped）

- **v1.0.0** 2026-05-27 发布。三-zone context（ImmutablePrefix 字节稳定 / AppendOnlyLog JSONL / VolatileScratch）。
- **确定性 send-time compaction**：纯函数 `compactCodeProductions()`，对 message 数组投影，JSONL 原始历史不被改写，tool_call/result 配对保留，幂等。
- **策略已泛化为 registry**：`ToolCompactionStrategy[]` 覆盖 6 个工具——
  - tool-call args 压缩：`write` / `edit` → `CodeProductionSummary`（path / chars / lines / head / tail / result 200 字，原始 args 留在 `rawArguments`）；
  - tool-result 压缩：`read` / `bash` / `search` / `find` → 各自结构化 summary（read 保留 ¶path#hash、行/字数）。
- **hybrid 延迟触发**：`compactAfterInputTokens`（默认 32000）门控整个投影，门下原样发送保 prefix cache，跨门后才改 prefix。
- **报告层**：`projectCompaction()` 产出可复核报告（trigger state、raw/compacted token、effective savings、保护的 assistant 消息数、per-tool 计数、per-message diff）。`/compact-status` `/compact-diff` `/compact-report` 与离线 replay 都消费同一 shape。
- **send-time thinking stripping**、input-token / tool-call 预算、hashline 编辑链（SHA-256 防陈旧读、多文件 preflight）、JSONL session、approval gating、artifact spill。
- **测试与脚本**：`compaction.test.ts` 26 个用例；`scripts/` 有 `dogfood-p0.mjs`、`replay-compaction.mjs`、token 观测脚本。
- **基础 dogfood 任务通过**：`results/dogfood-tasks/` 5/30 的 packet 全 pass（但都是 trivial 的 "contains hello" 校验，不构成优势区间证据）。

### 已被证伪 / 已知负面

- **激进设置是负面案例**：2026-05-28，`keep-recent=1` + `compact-after=2000`，50 turn 直接改造 orientation 文件 → input 降 47%，但 **124 次重读**。结论：token 省了但行为劣化，属于「直接转换型工作流」的 negative case，不是推荐设置。
- **Mimo 无可用 cache 信号**：on/off 都报 0，cache 轴在 Mimo 上无诊断价值，已从 P0 撤下，仅留给未来 DeepSeek API。

### 尚未完成（真正的缺口）

1. **干净的推荐参数 A/B 没有**：`keep=3` + `compact-after=32k` 的 paired on/off、在 refactor / exploration 两类优势区间工作流上、带人工质量复核（completion / re-read / tool-call / 主观质量）的结果——没跑。
2. **「~15-17% token savings」对不上账**：现有 docs 里只有 47% 的激进负面案例，没有 15-17% 的记录。这个数字要么在别处、要么需要重新跑出来。**对 Leader 展示前必须用干净 run 重新确立**，否则数字站不住。
3. **dogfooding 自改卡住**：小模型（Mimo）在有限智力下无法稳定独立运行并修改自身 compaction，靠 codex 监工进度慢。这是 harness 层的痛，不是 compaction 算法的痛。
4. **externalization backlog 未动**：`compactCodeProductions` 仍硬编码 `DEFAULT_TOOL_COMPACTION_STRATEGIES`、tool-name 字符串匹配、path/hash 提取耦合 hashline。要移植必须先把这三处做成可注入。
5. **full（LLM-summary）compaction 仅留接口**，未实现（`compaction.full.*` 占位，代码末尾有 TODO）。

---

## Part 2 · 续行 vs 重做方案

### 核心判断

把「重做」拆成两层来看，结论就清楚了：

| 层 | 现状 | 建议 |
| --- | --- | --- |
| **harness**（loop / tui / provider / session / approval） | dogfooding 自改痛点的来源 | **换掉**——用 picode 提供可运行 loop |
| **compaction 子系统**（策略 + 报告层 + hashline 思想） | 成熟、有测试、近可移植，是真正的 intellectual asset | **不要重写，移植** |

原始计划「fork picode 从零重搭 compaction」会把唯一已经成熟的资产又推倒一次。更优路径：**adapter 式移植**——保留 taucode 的 compaction 纯函数与报告层，写一层薄适配接到 picode 的 message/loop 上。这正是 repo backlog 里已命名的 "Prepare Compaction For Externalization"，只是当时没做。

> 注：picode 不在此环境，无法读其 context/history 结构。下面的移植边界以 taucode 侧的耦合点列出；你在本地需对照 picode 的 Message / history 管理入口确认对接位置（这是重建第一步该做的摸底）。

### 搬 / 改 / 弃 清单

**直接搬（核心资产，逻辑不动）**

- `compaction.ts` 的策略函数与 `CodeProductionSummary` / 各 result summary 结构。
- `compaction-report.ts` 的 `projectCompaction()` 报告层（trigger / diff / effective savings）。
- 报告 shape 作为 `/compact-*` 命令与 replay 的统一契约。
- `compaction-evaluation.md` 的理论（cost curves、failure modes、first-reply 假设）——直接作为技术文章骨架。

**改造后搬（先做 externalization，再接 picode）**

- `compactCodeProductions(messages, options)` → 增加注入点：`strategies`（替代硬编码 registry）、tool-name 匹配函数、path/hash 提取函数。
- `Message` / `ToolCall` / `ToolResult` 类型 → 适配 picode 的消息模型（最可能的真实工作量在这）。
- read-result summary 的 hashline 提取（`¶path#hash`）→ 若 picode read 不用 hashline，改为可注入的 path/hash extractor 或退化为 path+行数。
- 三-zone 的 `stripThinkingForSend` 与字节稳定 prefix → 对照 picode 是否已有等价的 prefix/cache 处理，避免重复。

**弃 / 暂不带**

- taucode 自己的 tui / provider / session（picode 已有）。
- `apps/` `src/math` 等与 compaction 无关的脚手架。
- full LLM-summary compaction 的占位（除非要做对比实验，否则别在重建期背它）。

### 重建顺序（建议）

1. picode 跑通基本 loop（先确认 history/context 管理入口）。
2. 把 compaction 三处耦合做成可注入（externalization）。
3. adapter 接入 picode 的 message 模型，compaction 作为独立模块插入，**与上游 diff 最小**。
4. 接 picode 的 Mimo token plan，跑推荐参数 paired A/B（见 Part 3 实验清单），拿干净数据。
5. 数据成立后，再以技术分享姿态对接崔的讨论。

### 三层分工（沿用你的设计，判断权不下放）

- **你**：定 turn 分类判准、定实验设计、读 A/B 结论。
- **tau（在 picode 上自改）**：执行 + 自测 compaction 逻辑。
- **codex / claude code**：审结果、做高层判断。
- **mimo**：低认知杂活（TUI、格式、简单重构），不碰策略层。

---

## Part 3 · compaction 策略评估

### 策略本质

taucode 的赌注：**用纯函数在 send 时压缩，而非 summarization LLM call**。压缩是「orientation 折旧」机制——模型读完文件、把语义写进叙述后，原始读结果降格为 hash 寻址的引用，而不是每一轮都付费重传。

它同时治两条成本曲线：

- **A. 重复 orientation 传输**：早期读的文件被后续轮反复重发，线性 `O(N·O)` → 由 read-result 压缩治理。
- **B. 累积工作产物**：write/edit args、read 结果、叙述累积，二次 `O(N²·avg/2)` → 由 code-production args 压缩治理。

### turn 分类判准（你的核心输出）

现有实现已隐含一套「丢弃 / 压缩 / 保留」判准，把它显式化就是文章的核心论点：

| 类别 | 判据（现实现） | 处理 |
| --- | --- | --- |
| **必须保留** | 最近 `keepRecentAssistantMessages`（默认 3）内的 assistant 消息；失败的 tool call；小于阈值的 args/result | 原样 |
| **可压缩** | 窗口外的成功 write/edit（args > `minArgTokens` 800）；窗口外的成功 read/bash/search/find（result > `minResultTokens` 200） | 替换为结构化 summary，保 path/hash/行数/head-tail |
| **可丢弃（更激进，未实装）** | 已被后续叙述完全蒸馏、且证实不再被引用的原始结果 | 当前只压不丢；丢弃需要「引用追踪」证据，是下一个研究点 |

判准的理论支点是 **first-reply semantics 假设**：模型用完工具后会把关键语义写进下一条文本回复。成立 → 后压几乎无损；失败模式有三：silent execute（只调工具不说话）、process-only text（"let me check" 而无结论）、latent details（当时忽略、多轮后才需要的细节）。缓解：调大保护窗口、抬高 `minResultTokens`、`--read-dedup`、用 system prompt 强制 post-tool 摘要。

### 相对优势区间（vs multi-agent / 全量 compact）

| 方案 | orientation | 工作产物 | 额外 LLM 成本 | 可复现 | provenance |
| --- | --- | --- | --- | --- | --- |
| 大 context 硬扛（Claude Code 默认） | 全留 | 全留 | 无 | 是 | 全 |
| 全量 LLM summary（/compact） | 摘成散文 | 摘成散文 | summarizer in+out | 否 | 易丢 path/配对 |
| multi-agent 分拆 | 子 agent 各自 orient（可能重复 orient） | 跨 agent 协调开销 | 多次 call | 取决于实现 | 边界处易丢 |
| **taucode 确定性压缩** | 阈值后自动压成 hash 引用 | 自动压成结构化 summary | **无** | **完全确定** | **结构化保留 path/hash/配对** |

**优势区间**（应明确圈定为论文的适用域）：长单 session、code-production 重、便宜小模型、多轮、provider cache 不足以抹平重复 input 成本。形式化假设（来自 eval 文档，**待数据验证**）：>20-30 turn 时，总 input token 比 no-compaction 低 30-60%，比 LLM-summary（含 summarizer in/out）低 10-25%。

**劣势区间**（必须诚实写进去，否则不可信）：直接转换型工作流（持续需要精确原始 orientation）→ 摘要不足、模型重读，即 5-28 的 47%/124-重读 负面案例。控制手段：`--no-compaction`、抬高 `compactAfterInputTokens`、加大保护窗口、`--read-dedup`。

### 待校准 / 待验证（重建后要跑的实验）

| 优先级 | 实验 | 指标 | 状态 |
| --- | --- | --- | --- |
| P0 | 同任务 compaction on/off paired（refactor + exploration，`keep=3` `compact-after=32k`） | completion、re-read、tool-call、主观质量、总 token | **未跑（核心缺口）** |
| P0 | sweep `compactAfterInputTokens` 4k/16k/32k/64k | 阈值前后行为、turn 数、tool call | 未跑 |
| P1 | sweep `keepRecentAssistantMessages` 1/3/5/10 | 连续性、time-to-forget | 未跑 |
| P2 | DeepSeek API cache 对比 | cache hit/miss | 等 cache-capable provider |
| P2 | vs 全量 LLM-summary（含 summarizer 成本） | 总 token + 质量 | full compaction 未实现 |
| 新 | **引用追踪 → 支撑「可丢弃」判准** | 被压缩 path 是否真被后续引用 | 研究点，可成第二篇 |

### 给 Leader 展示的可信度要点

1. 先有干净 P0 数字，再讲故事。47% 是负面案例，不能当卖点；15-17% 需重新跑出来坐实。
2. 诚实写劣势区间——确定性压缩的精确 provenance + 零 summarizer 成本，本身比夸大节省率更有说服力。
3. 「turn 分类判准 = 产品能力」是比「能省 token」更高级的论点，作为主轴。
4. repo 干净 + README 讲清 what/why/how + 关键实验可复现，让对方自己来看。

---

## 重建时 checklist（速查）

- [ ] picode 摸底：定位 history/context 管理入口、message 模型、是否已有 prefix-cache/thinking-strip
- [ ] externalize：strategies 注入、tool-name 匹配注入、path/hash 提取注入
- [ ] adapter：taucode compaction ↔ picode message 类型
- [ ] 接 Mimo token plan，跑 P0 paired A/B（推荐参数）
- [ ] 重新确立干净的节省率数字（替换/坐实 15-17%）
- [ ] 把 `compaction-evaluation.md` 升级为对外技术文章（含劣势区间）

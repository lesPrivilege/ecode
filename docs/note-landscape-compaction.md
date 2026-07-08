# Note — compaction 方案 landscape 与 ecode 定位

> 2026-07-06 更新：R2 已跑完，带结果的新版调研见
> `docs/reports/compaction-strategy-research-2026-07-06.md`。本文保留为
> R2 前 landscape / 定位草案，供追踪判断演化。

2026-07-05。来源:操作者口述归纳,**已经 Grok 实时检索逐条核证**
(见文末核证结果,官方文档级引用可直接外发;第三方逆向类须标注
事实等级)。用途:论文对比节 + 发布叙事的定位依据。

## Frontier 现状(口述归纳)

**Server-side compaction 成为主流路径。** Anthropic:API 侧自动检测
token 阈值,生成结构化 summary 插入 compaction block,后续请求自动
丢弃 block 之前的旧消息。OpenAI:`/responses/compact` 或
context_management 参数,自动/手动触发,产出压缩快照(部分为
opaque/加密表示),客户端可选 local/remote 路径。xAI 等类似。

**下游 harness 做混合 pipeline。** Claude Code 约五层:Tier 1 客户端
轻量(清旧 tool results,保留最近 ~5 个)→ Tier 2 API 级 server-side
→ Tier 3 完整 LLM summarization(结构化 9 节:intent、files touched、
decisions、pending tasks 等)。Factory.ai 强调 structured summarization
(JSON 分节),评估称信息保留优于原生。框架级高级玩法:PreCompact
hooks(压缩前注入指令)、外部 memory(vector DB/graph/文件系统)、
autonomous compact(agent 自主决定时机)。

## 定位分析(ecode 视角)

**1. Server-side compaction 是论文论点的行业级证实。** 压缩发生在
cache 契约之内——服务商同时控制 summary 生成与 KV cache,压缩后的
新前缀天然可缓存,transition 成本内部化。OpenAI 的 opaque 快照是
最强形态:下游连内容都不可见,契约完全上收。这正是「跨层 cache 契约」
的现在进行时,也是三面墙裁决的注脚:上游做了,墙就不存在。

**2. DeepSeek 生态缺 server-side compaction——这就是 ecode 的空档。**
frontier 的推荐路径(依赖服务商能力)在 DeepSeek 上不可用;下游能做的
最优近似就是我们做的:确定性投影 + byte-stable 恢复 + hash 溯源,
把 server-side 的两个关键性质(压缩后可缓存、结构化保真)在客户端
逼近。若 DeepSeek 日后上线 server-side compaction,ecode 的 extension
即成为现成的对照基线——这本身就是给上游叙事的一部分。

**3. 与 Claude Code Tier 1 的收敛与分歧。** 「清旧 tool results、
保留最近 N」与我们的投影是同一动作——独立收敛到同一设计,佐证
这层是刚需。分歧在三处:我们无 LLM 调用(确定性、零 summarizer
成本、可复现);摘要带 hash 溯源(edit 物证 + stale-view 检测,
frontier 未见等价物);全链路 observability(gate/触发/CH 轨迹/
(d) 类指纹在 telemetry 机械可判)。Factory 的 structured summarization
与我们的结构化摘要理念同向,但它仍是 LLM 产出——非确定、不可
byte-stable,cache 性质不同。

**4. 高级玩法的对应物。** PreCompact hooks ↔ pi 的
`session_before_compact`(缝 B,已接);外部 memory ↔ 我们的
「文件系统为真相源 + hash 寻址视图」(方向一致,我们不引入
vector DB,凭据即文件);autonomous compact ↔ 意图声明设计种子
(retention 参数),我们把「模型自主」限定在声明层,裁量权留 harness
——比完全 autonomous 保守,理由是模型对自身未来需求的校准未经验证。

## 补:summarization 技术谱系与我们的坐标(2026-07-05 二次调研)

谱系:extractive(选原文片段,verbatim 保真、低幻觉)/ abstractive
(LLM 重写,流畅但易丢 file paths/error codes)/ hybrid;进阶:
Chain-of-Density(定长迭代增密,3-5 轮,多次 LLM 调用)、
map-reduce/hierarchical、anchored iterative(Factory:持久分节
summary,只总结新增段并入锚点,防累积丢失)、multi-agent refine
(NexusSum 类)、MemAgent 类 RL 记忆槽(研究向)、
tool-result clearing + selective pruning(确定性,Claude Code 与
开源普遍采用)。

**我们的坐标由此清晰:确定性投影 = extractive 的极端形态**——
选取即保留(path/hash/行数/head-tail 全 verbatim),零重写、
零幻觉面、byte-stable。这解释了保真性质的来源:Factory 测得原生
abstractive 恰恰弱在 file paths 与 error messages 的保留,而这些
在 extractive 谱系里是**构造性保住的**,不是优化出来的。
「工作语义保留」的宣称由此获得谱系学支撑:我们不是做了更好的
summary,是选了保真性由构造保证的那一支,并加上 provenance。

对打磨队列的映射(不动摇主线,全部数据门控):
- **结构化摘要升级**(触发:(b) 类占优):参考 anchored iterative
  的分节思想——但保持确定性生成,分节由 tool 类型与符号结构给出,
  不引入 LLM 调用;
- **CoD**:仅适用于 LLM-summary 臂(B 臂)的强化版,或将来
  「摘要质量对照」实验的 B+ 臂——每 summary 多次调用的成本
  在我们的经济学里天然劣势,不入主线;
- **MemAgent/KV-cache 级压缩**:研究向,论文 related work 引用,
  不实现。

## 一句话定位

frontier 用 server-side + LLM summary 解决「忘什么」;ecode 在
无 server-side 可依赖的生态里,用确定性投影解决「怎么忘得可验证」。
两者不是竞争关系:前者是上游做了契约,后者是下游把契约缺席时的
最优解做成了可测量的对照组。

## 核证结果(2026-07-05,Grok 实时检索,逐条带官方出处)

- [x] **Anthropic**:server-side compaction 官方文档在案
  (platform.claude.com/docs/.../compaction,beta `compact-2026-01-12`,
  `context_management` 参数,阈值可配)。官方文档级。
- [x] **OpenAI**:`context_management.compact_threshold`(server-side)
  + stateless `/responses/compact`;压缩产物为 **encrypted compaction
  item**(opaque 确认)。官方文档级。
- [x] **xAI**:Context Compaction,opaque item,docs.x.ai(2026-05)。
- [x] **Google**:`context_window_compression` 配置 + CLI compress。
- [x] **Mistral**:未见明确 server-side compaction(client-side history
  management + caching 为主)。
- [x] **Claude Code 客户端分层**:官方确认 server-side 推荐 +
  tool-result clearing;tiered 细节(micro-compact/auto ~83% 阈值)
  来自第三方逆向,引用时须标注事实等级。
- [x] **Factory**:官方评估(factory.ai/news/evaluating-compression,
  2025-12-16):structured summarization 3.70 vs Anthropic 3.44 /
  OpenAI 3.35,「file paths 与 error messages 保留更优」。
  "anchored iterative summarization, explicit sections"。
- [x] **DeepSeek**:官方仅 disk-based prompt caching(默认启用,
  hit 大幅降价),**无 compaction 能力且无公开计划**——空档定位
  由证据确认。
- [x] **pi 上游**:compaction.md 在案(LLM summarize old messages),
  与 G0 摸底一致。

## 两条战略级发现(核证的增量产出)

**1. cache trade-off 无公开一手量化——G2 将是第一批。** 社区对
「compaction 破坏 prefix/KV cache」有定性讨论(总结后延迟上升、
prefix reuse 重置),但**未找到「hit 掉 X%、N turn 恢复」的一手
公开测量**。这把 G2 round 1 的性质从内部决策数据升格为公开领域
的首批此类数据——transition dip 深度、恢复曲线、双模态分布,
每个数字都是可发表的增量。发布叙事与 upstream-narrative 相应升级。

**2. retention hint 的 prior art 是 harness 侧清理,非模型声明。**
已存在的近亲:Anthropic tool-result clearing、ephemeral
cache_control、确定性 pruning——全部是 **harness 决定丢什么**。
view-based 种子的核心主张(**模型在 call-time 自述留存意图**,
harness 保留裁量)未见先例,adjacent art 存在但声明主体不同。
种子立项时 prior-art 节按此写:站在 tool-result clearing 的
延长线上,新增的是声明权移交与校准可测。

---

## 增补（2026-07-08）：From Context Pruning Taxonomy to Compaction Economics

来源：frontier「context 修剪」机制专项调研（官方文档 + 源码 + 社区
逆向，逐条带引用；社区逆向类须按事实等级标注）。结论：公开生态列出的
不是一种机制而是层级菜单，真正的区分维度是 **cache 形状 × 可复现性 ×
失效指纹**——三列全部缺席于通用分类学。压缩表：

| 形态 | 实例 | cache 形状 | 可复现性 |
| --- | --- | --- | --- |
| LLM 全量摘要替换 | Claude server compaction（`compact_20260112`）、Claude Code `/compact`、Codex 本地 compact | summary 新写，常破前缀 | 低-中 |
| 远端 opaque compact window | OpenAI `/responses/compact`、Codex remote compact | endpoint 返回 canonical window | 低（encrypted item 不可审计） |
| send-time projection / collapse | Claude Code context collapse；本 repo seam-A | 原历史保留，投影字节稳定可重建 cache | 中-高 |
| tool result clearing | Anthropic `clear_tool_uses_20250919`、Claude Code microcompact | 清除点破 cache；`clear_at_least` 显式定价 | 高（无状态纯函数同构） |
| thinking clearing | Anthropic `clear_thinking_20251015` | keep all 保 cache，clear 破点后 | 高 |
| subagent 隔离 | Claude Code subagent research | 父前缀不吃大读入 | 高 |
| 初始上下文重注入 | Claude Code CLAUDE.md survival table、Codex initial context injection | 重注入位置决定前缀稳定性 | 高 |
| provider/model 分叉 compact | Codex remote/local 双路径 | 远端依赖 endpoint 能力 | 中（failure 样本多） |

要点三条：① Anthropic 已把 cache 断裂写进参数面（`clear_at_least`
官方明文「worth breaking your prompt cache」）——frontier 在收敛向
本 repo 的记账框架，但无人给参数画实测曲线；② 触发伪代码
`if tokens_used > threshold` 的工程内容在「tokens_used 在哪个对象上
测量」——Codex auto-compact 的门控变量对齐问题与本 repo 发现 1
（门控自污染）同源；③ 「谁生成摘要」是账本分叉处不是实现细节：
LLM 摘要付推理费且不可复现，确定性投影零边际——R2 终判压在这条线上。

本 repo 的消费路径：G4 系列（`arch-frontier-pruning-design-2026-07-08.md`）
把表中「tool result clearing」行复刻为客户端确定性纯函数，三列账本
第一次覆盖非原生机制；后续批次候选 = thinking clearing、cache-aware
pinning、初始上下文重注入。

# Note — 投影 turn 的真变量：机制 review、命中率分解与微调提案

2026-07-08，Fable。触发：polish 前的机制盘点 + 一个正确的怀疑——
「前缀改变，命中率数值变少，是不是只因为 input 本身变少了？每个生效
turn 的真正变量在哪里？」答案：是的，比率是被污染的观测量；真变量
是两个绝对量（见第三节）。盘点顺带发现一个未被根因化的门控缺陷
（第二节发现 1），全 corpus 普遍。

## 一、现行机制逐节点 review（file:line，以 2026-07 源码为准）

| # | 节点 | 位置 | 行为 | 我们期待 |
| --- | --- | --- | --- | --- |
| 1 | 门控读数 | `extensions/.../projection.ts:87-91` → pi `estimateContextTokens`（`pi/packages/agent/src/harness/compaction/compaction.ts:169`） | 读数 = **最后一条 assistant 的真实 usage** + 其后消息的 chars/4 估计 | 读数应单调反映原始 transcript 的规模（实际不是——见发现 1） |
| 2 | 恒等路径 | `projection.ts:89-91,99-103` | 阈下原引用返回，字节不动；compactedCount=0 同样恒等 | 阈下零代价、prefix cache 全吃 ✓（fixture 锚定，R16） |
| 3 | 投影路径 | `projection.ts:93-106` → `compactCodeProductions` | 纯函数、幂等、send-time only 不落盘 | 同状态同字节 ✓ |
| 4 | 年龄边界 | `packages/compaction-core/src/compaction.ts:889-905` | recentCutoff = 倒数第 keepRecent(3) 条 assistant 的消息索引；配对 assistant ≥ cutoff 的 tool result 受保护 | **每 turn 恰好一条 assistant 老化出窗** → 投影谱系内每 turn 都有一次近尾断点（边界税，见 3.4） |
| 5 | 策略集 | 同文件 DEFAULT 策略 | read/bash/search/find 结果 ≥200 tok → 结构化摘要（path、行数、head/tail）；write/edit args ≥800 tok → code-production 摘要（head/tail、结果头 200 字符）；错误结果永不压；protectedPaths 跳过 | 摘要保 path 与规模事实，丢正文 ✓；hash/diffstat 仅 trust flag 开启时注入（v1 默认 OFF） |
| 6 | 旗标面 | `extension.ts:18-20,139-197` | v1 默认在场的只有：混合门控 + 策略投影。trust/anchor/WS/sideband/placebo 全部默认 OFF | C 臂 v1 = 「门 + 策略」裸机制，R2 测的就是它 |
| 7 | 观测 | run JSONL turn 行 | input_est（chars/4 payload 估计）、cacheRead（provider 计数）、projected、re_reads… | 见发现 2：两列单位不同，绝对 miss 不可计 |

## 二、盘点中的两个实测发现

### 发现 1 — 门控自污染：投影/恒等周期 2 振荡（全 corpus 普遍）

机制链条（每步有 file:line）：

1. 投影 turn 发出 ~14k payload，provider usage 记的是**这个投影后规模**；
2. 下一 turn 门控读数 = 该 usage + 少量 trailing 估计（pi compaction.ts:169-196）
   ≈ 14k+ε < 32000 → 恒等 → **全量 raw（~35k）重新发出**；
3. 这个 raw call 的 usage 又把读数抬回阈上 → 再投影 → 回到 1。

门控变量被自己的动作污染——G1b 修正 #2「复用 pi 估计器、禁自造
char-count」把 usage 反馈无意间接进了门控。实测（15-r2-G2-R1-C，
DeepSeek 真 run）：

```
turn 17    raw 28087        （阈下爬升）
turn 18 P  proj 10659  hit 2176   ← 断裂税：hit=共享前缀=系统区
turn 19    raw 31357  hit≈全额   ← 门控回落，全量重发（raw 谱系还在 cache 里）
turn 20 P  proj 14345  hit≈全额  ← 投影谱系字节稳定的直接证据
turn 21    raw 35209 … 之后 P/非P 严格交替到 run 结束
```

普遍性：32k 阈值的 C/D 臂真 run 几乎全部 flips≈postTurns（corpus 扫描，
30/53 个 seam-A run 判振荡）；**8k 低阈 D1 run 例外**（05-r1-D1-D flips=2）
——投影后 payload 仍 >8k，读数不回落，天然闩住。例外反证机制。

与既有记录的关系：`r2-turn-interaction-retro` L84 观察到 "alternating
payload regimes"，但归因为门控的合法状态（"when under the gate"）。
本次增量：根因（usage 反馈耦合）、周期性（严格周期 2）、普遍度定量、
以及反证样本（8k）。

成本形状：两条 cache 谱系交替续命，各自 hit 都高（DeepSeek 把两个前缀
都留着），但奇数 turn 仍按 0.1× 重付整条 raw 前缀——**常驻集折扣只在
一半 turn 上兑现**。语义形状：模型隔 turn 看到两个不同视图（全量 vs
投影），对轨迹稳定性的影响未测。

诚实边界：这不自动推翻 R2——R2 的 1/3 成本**含着振荡**测出来的；
修复只可能更好或持平，但那是待测命题，不是结论。SWEEP-R2 仍按 v1
冻结跑（可比性纪律），修复做成 flag 走 C-v1.1 追加评估。

### 发现 2 — 绝对 miss 在现遥测下不可计（单位错配）

turn 行的 input_tokens 是 chars/4 估计，cache_read_tokens 是 DeepSeek
tokenizer 计数。同一 run 里 est-hit% 长期 >100%（15-r2 稳态 110-125%），
`miss = input_est − cacheRead` 大面积为负。任何用这两列算的「命中率」
既混单位又混分母——用户的怀疑在仪表层就成立了。

## 三、命中率分解：每个生效 turn 的真变量

把 turn t 的送出 payload 切三段：

```
input_t = matched_prefix_t + rewritten_band_t + organic_Δ_t
          （cache 命中段）    （投影改写段）     （上轮新增：assistant 输出+tool 结果+注入尾区）
```

- **比率 hit_t/input_t 为什么是坏观测量**：投影使分母缩小、又使
  matched_prefix 截断到共享区，两个效应同向压低比率——「cache 坏了」
  和「payload 高效变小了」在比率上不可分。这就是问题里那句话的形式化。
- **真变量 1：excess_miss_t = miss_t − |Δ_t|**（超出有机新增的重付量）。
  A 臂稳态 excess≈0（纯 append）；投影 turn 的 excess = 断裂税；
  振荡 run 的奇数 turn excess = 整条 raw 前缀重付；理想闩住的 C 臂稳态
  excess ≈ 年龄边界带（keep-recent 窗口 raw 内容/turn，见 3.4）。
- **真变量 2：matched_prefix_t 的绝对值**（每 turn 按 0.1× 重付的常驻集）。
  投影红利 = (P_raw − P_proj) × 0.1 × 有效余程——**这一项在比率里完全
  不可见**，它只出现在 hit 的绝对量对比里。note-256k 的收益公式
  （新前缀每 turn 折扣 × 有效剩余轨迹 − 一次性断裂税）的可测映射即此。
- **免费仪表（本次盘点的正收获）**：投影 turn 的 cacheRead **就是断点
  偏移**（共享前缀长度，block 量化）。15-r2 turn 18 hit=2176 = 系统区
  +早期稳定段的长度——我们向 DeepSeek 要的「前缀断在哪」字段，在
  投影 turn 上已经自测得到。turn 20 hit≈全额则是投影谱系字节稳定的
  野外直证。
- **3.4 稳态边界税**：年龄边界每 turn 推进一条 assistant（机制 #4），
  新老化的 tool result 由 raw 换 summary，断点落在距尾 ~keepRecent 处
  → 投影谱系内每 turn 重付「边界之后的全部」≈ keep-recent 窗口的 raw
  尺寸。A 臂没有这项。它是投影的**经常性**成本，与一次性断裂税分账。

## 四、微调策略提案（全部 flag 默认 OFF；参数与排期归人）

优先序：P3 → P1 → P2 → P4。每条附可证伪预测与最便宜检验。

- **P3 仪表增量（先于一切，否则 P1/P2 的账审不动）**：turn 行加
  `input_tokens_usage`（provider prompt_tokens）与 `cache_miss_tokens`
  （DeepSeek 原生返回）；投影 turn 记 `break_offset = cacheRead`。
  schema 只增不改。检验：一次 mock + 一次真 run，新列与 hit+miss=prompt
  恒等式对账。
- **P1 门控闩锁**：越阈后粘滞（session 内不回落），或门控读数改用
  content-only 估计（不混 usage；等价于对机制 #1 去耦）。预测：P/非P
  交替消失；post-crossing 段 excess_miss 积分显著下降（方向预测，数字
  等测量）；投影谱系 hit 曲线不再被 raw 谱系稀释。检验：mock 序列单测
  （门控读数轨迹断言）+ R1 packet 32k 配对复跑 ×1。
- **P2 边界批处理**：recentCutoff 按 B 条 assistant 量化推进（B=4 起）。
  预测：批间 turn 投影输出纯 append（谱系内 hit→全额），CH 呈周期 B
  锯齿；语义代价 = 摘要延迟 ≤B turn（更保守，无损方向）。检验：
  compaction-core 纯函数单测（相邻状态输出前缀关系断言）+ mock 重放。
- **P4 红利感知触发（远期）**：门控从「尺寸阈值」升级为「红利估计」
  ——可移除常驻集 × 预期余程 × 0.1 对比一次断裂税；余程代理用 pending
  ledger（WS 已有）。等 P1-P3 数据落地再设计，不排期。

## 五、本 session 作为标本（用户点题：分发/回收/context 状态本身即命题）

- **三档位对角线的活例**：本 session 三个 subagent（两 chore + 一 audit）
  各自消耗 13-19 万 token，回收物是 1-2k token 的结构化报告——构造性
  隔离 + anchored summary。主 context 只付「摘要价」，而回收质量取决于
  报告的锚点密度（file:line、SHA、逐条验收输出）——与 C''/语义锚点的
  设计判断同构：**结构化锚定优于散文**，回收即投影。
- **主循环的手动投影**：offset/limit/grep 式读取 = view-based context
  的人肉版；每个 tool result 进入不可变前缀 → prompt cache 命中率高但
  窗口消耗单调增——监工 session 与 A 臂长会话同形，同样受
  「稳定前缀 + append-only」经济学支配。
- **声明性工作语义在 harness 层的对应物**：TaskCreate/Update = intent
  ledger；chapter 标记 = 语义锚点；goal hook 的目标条件 = pending target。
  这些结构使 session 可被外部审计——与本 repo 给 DeepSeek run 建的
  观测面是同一命题。
- **风险对称**：本 session 若被 harness 的 LLM-summary 压缩，即 B 臂；
  已有一次 (d) 类事故在案（B-arm compaction incident，监工侧）。协议
  已成文：偏好新会话 + 重锚而非原位压缩。失效分类学对监工 session
  同样适用——「分类学不随权重折旧」的又一证据面。

## 关联

`docs/reports/r2-turn-interaction-retro-2026-07-06.md`（交替现象首记）·
`docs/note-256k-plateau-context-economy.md`（收益公式）·
`docs/fingerprint-detectors-design-2026-07-08.md`（(d) 判别与 CH 注记的
单位 caveat 同源）· `docs/sweep-r2-dispatch-2026-07-08.md`（v1 冻结跑法）·
roadmap H2/H3（dispatch policy / context protocols 的上游条目）

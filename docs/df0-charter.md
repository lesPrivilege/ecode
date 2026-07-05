# DF0 章程 — 真实 tool-use dogfooding（一周）

2026-07-05。前提：launcher 全绿（T1-T10 + R1-R5，0 FAIL），真 key 链路通，
extension 确认加载，ambient telemetry 每 session 落盘。

## 为什么 tool use 是主战场

脏数据几乎全部经 tool result 注入：read 的大文件原文、bash 的无界输出、
edit 的 diff 回显。它们同时是——压缩的主要标的（曲线 A/B 的载体）、
配对完整性的风险点（broken pair 即前缀断裂）、以及 F-A 口径下
compactable-content 的实际来源。轻量测试永远到不了这里：banana 不产生
32k 可压缩内容，`read` 一个 900 行文件会。

## 做法

用 `ecode` 做真实日常工作（本 repo 的工程杂活、taucode 只读分析、
其他项目均可），**不设剧本**，但保证 read / edit / bash 三类高频出现。
参数保持推荐档（32k / keep=3），不手动压阈值——要的是**自然越阈**。

**Pre-flight（2026-07-05 round 1 污染教训,每次 DF0 session 开始前必做）**：
新开 session（不复用测试遗留进程）,首个动作 `/compact-status` 确认门控
读数为 32000/keep=3。读数不对 → 关掉重开,不带病采集。round 1 因 R5 遗留
`compact-after=500` 未清,全部数据降级为 500-regime 压力样本（隔离归档,
不作自然越阈证据）。

## 观察清单（ambient 自动记 + 遇到时人工补记）

1. **第一次自然越阈**：越阈前后 footer CH% 轨迹（transition 掉多少、
   几 turn 恢复）——90→15→87 曲线的第一个野生样本。
2. **净省台账（核心问题的数据地基）**：每次 compaction 触发记三个数——
   省下的 input tokens、cache-hit 损失量（CH% 差 × context 规模）、
   DeepSeek cached/uncached 价差折算。净省 = 省的 − 断 cache 多付的。
   G2 出因果结论，DF0 先出量级感。
3. **配对完整性 + 重读分诊**（2026-07-05 已观察到野生重读,升级为结构化记录）：
   每次 compacted-path re-read 记一条——path、被哪个策略压的、重读次数、
   **重读后决策是否成功**、归类 (a)/(b)/(c)：
   - (a) 理性恢复:任务需要精确原文 → 负区边界样本,对策是 workload 识别；
   - (b) 摘要结构缺陷:summary 缺定位信息致无法决策 → 改 per-tool 策略
     （strategies 注入点,summary-at-read 方向）；
   - (c) 循环病理:反复读同一 path 无进展 → 移植 taucode read-dedup。
   分诊判据:重读后成功 → (a)/(b)（看它用了原文的什么）；仍不成功 → (c)。
   ≥5 条分诊记录即可开专项复盘,(b) 类占比是策略打磨的直接输入。
4. **体感摩擦**：模型「变笨」时刻记 timestamp，回查当时投影状态
   （round 1 复盘承诺的回查能力，第一次实战）。
5. retention 数据：一周后 ambient 文件数/总体积（裁决 #1 的输入）。

## 纪律

- 观察不干预：发现可疑不当场调参数,记下来等复盘（校验节流原则同样适用）。
- 数字不外引：DF0 是轶事级,量级感可以进复盘讨论,不进论文正文——
  论文数据等 G2 配对 run。
- 一周或首次自然越阈 + 净省台账有 ≥3 个样本,即触发 DF0 复盘。

## 与 G2 的关系

DF0 出分布（真实 tool-result 尺寸、越阈频率、re-read 野生率），
G2 出因果（C vs A 同任务配对）。Code session 提的三条 heavyweight 方向
（treatment/control、自然越阈、质量压力）中,前者即 G2-R1/E1/D1 首轮,
后两者由 DF0 覆盖。快照构建 + 12 run 与 DF0 并行不冲突。

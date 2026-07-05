# ecode 总纲 — 2026-07-05 session 收束与续行索引

一天内从 working paper 探索到可跑验证台的全部裁决归档。本文是**唯一续行
入口**:数据回来后,按第三节裁决点逐条落。文中每个方向都标注触发条件——
无数据不开工是全项目第一纪律。

## 一、已落定（完成态,不再动）

| 层 | 内容 | 证据 |
| --- | --- | --- |
| 基建 | G0 fork/survey、G1a compaction-core（含包级字节等价）、G1b extension、G1c 四臂 harness、G1d packet-loader/快照、G1e provider wiring | 各自 commit + 双重独立验证 |
| 观测 | DF1 三命令 + 触发标记、DF2 runtime 调参 + 事件记录、ambient telemetry（含 flag 状态） | launcher 双轮实测 |
| 信任协议 | V2-TP 全切片（flag 默认 off）:ledger、summary hash+diffstat、stale-view hint 尾区注入 | 100/100 + 野外 R3/R4 决定性通过 |
| TUI | DF-TUI S1-S5(gate 条/触发标记/CH 微条/hint 指示//compact-dash) | 单元级验收,S2 独立 audit |
| launcher | `ecode` 命令:隔离 profile、env 路由、自愈 symlink、可选 profile 文件 | T1-T10 + R1-R5,0 FAIL |
| 纪律 | loop-protocol（改/记分界、校验节流、弱模型围栏）、pre-flight、绊线、pathspec commit | 多轮实战修订 |

## 二、进行中/待执行

1. **Codex TUI 总验收**:五图叙事（唤醒 prompt 已给）。副产品:ambient 采集。
2. **G2 round 1**（全项目关键路径,人侧）:key → `prepare-snapshot.ts` →
   按 `g2-run-manifest-round1.md` 12 run（臂序已定死）。v1 冻结中。
3. **G2 round 2**:+C' 臂（`ECODE_TRUST_PROTOCOL=1`),(d) 率 flag-on/off
   对比 = 信任协议生死判据。

## 三、双复盘裁决点（数据到位后,按序裁）

1. **净省台账**:C vs A——省下 token vs 断 cache 多付（DeepSeek 价差折算）。
   双模态分布假设的因果检验。结果分叉:正/中性 → 发布路径 B 全叙事;
   负 → 质量叙事 + 诚实注记（负账是论文素材非发布障碍）。
2. **v2 策略选型确认**:trust-protocol 切片先行的预判,由 round 2 (d) 率
   确认或推翻。
3. **优势区间命题**:C 在长 session/code-production/便宜模型上同时赢 A、B
   （token↓ 且盲评质量不劣化）——三者缺一即命题不成立,照 roadmap 止损。
4. **发布定稿**（`note-release-paths.md`):路径 A 插件即发;路径 B
   「DeepSeek-first」宣言按台账结果定;主叙事 = context 质量。
5. **retention 裁决**:ambient 一周总量 → 裁 cap/日滚/不动。

## 四、策略打磨方向（全部数据门控,按触发条件排队）

| 方向 | 内容 | 触发条件 | 依赖 |
| --- | --- | --- | --- |
| 结构化摘要升级 | per-tool summary 加定位信息（符号名/head-tail 增强） | 分诊 (b) 类占优 | G1a strategies 注入点,便宜 |
| read-dedup 接线 | (c) 类循环病理检测（T4 评估报告已备,方案:tool_result replacement seam + ledger） | (c) 类首次野外/G2 观测 | 评估报告 → 最小接线 |
| view-based context | 意图声明参数 + 语义台账 + hash 失效（`note-view-based-context.md` 三位一体） | (a) 类新意图定向重读占优,或 D1 视图化对照臂验证净流假设 | V2-TP ledger 已是雏形 |
| 校准指标 | 「声明 disposable 但重读」率 = 模型自知度,跨模型即能力等高线 | view-based 立项后免费副产品 | 分诊表加一列 |
| loop-engineering (D4) | narration-masking 投影审 三臂 × 任务长度梯度,找交叉点 → dispatch policy | G2 round 1 后可插批次 | 交叉点变量 contextTokens 免费可观测 |
| runtime policy 自动化 | 手动调参样本 + (d) 判别器 → 自动开关/阈值策略 | DF2 事件记录 + D4 交叉点数据齐 | 最后做,防无据自动化 |

## 五、测试回填方向（结欠清单）

- **(b)/(c) 类样本**:语料缺口,由 G2 R1/D1 受控产出,不再野外磨。
- **500-regime 对照**:round 1 污染数据留作第二激进样本,sweep 轮
  (4k/16k/32k/64k) 时正式纳入压力区间曲线。
- **E2E mock 重放扩展**:trust-fixture 目前单场景（edit→stale-read）;
  round 2 前补多文件并发 + compaction 与 hint 交互的场景(野外 R4 的
  fixture 化)。
- **TUI 快照测试**:S1-S5 纯函数渲染有单测,缺跨切片组合渲染的
  golden-file 快照——DF loop 顺手补。
- **launcher T9 遗留**:profile 文件 chmod 600 的提示/检查未做,低优先级。

## 六、新 DF 工作项（用户指定,交 DF loop:Opus 切片,DS/Codex 执行）

### DF-SKILL · pi skills 兼容最小实现

pi 原生有 skills 系统（`src/core/skills.ts`,SKILL.md 约定——g0 时代
确认的免费件）。工作不是造系统,是**验证 + 首个可用件**:
1. 验证 skills 在 ecode 隔离 profile（`PI_CODING_AGENT_DIR`）下的
   发现/加载路径(类比 extension 的 Item 6 摸底,产出 survey Item 9);
2. 写第一个最小 skill:**web-fetch**(SKILL.md + bash curl 脚本,
   取 URL → 纯文本;明确边界:无 JS 渲染、超时、大小上限);
3. 验证 skill 内容与 compaction 的交互:skill 文件读取是曲线 A 的
   测试面,确认落在可压缩区且 summary 保 path。
围栏:skills 是数据文件,不碰 pi;不做通用 skill 框架,一个能用为止。

### DF-REC · session 记录缓存(供 review)

pi session JSONL 已持久化,ambient 已有指标行——缺的是 **review 友好的
汇总层**:
1. `/session-export`(或 post-session 脚本):把 session JSONL 路径、
   ambient 行、`/compact-dash` 终态、触发标记列表打包成一份
   `results/reviews/<session-id>.md`;
2. 内容口径:F-A 双口径分别标注;compaction 后形成的断言若可识别则
   标记(出处纪律的延伸,尽力而为不强求);
3. 隐私边界同 ambient:不出本机、gitignored。
用途:复盘时人读一份 review 文件替代翻原始 JSONL;也是将来
「session 历程归档」的数据源。
围栏:只读现有数据源,不新增采集点;不碰 pi。

## 七、依赖与执行序

```
Codex TUI 总验收 ──┐
DF-SKILL ‖ DF-REC ──┼──(并行,不互斥)
G2 round 1(人:key+快照+12run)──→ G2 round 2(+C')──→ 双复盘
                                                        │
                              第三节裁决点逐条落 ←──────┘
                              第四节打磨队列按触发条件放行
```

论文侧同步:三面墙笔记、双模态发现、监工压缩事件(B 臂失效 + 恢复协议
成对样本)、「构造 vs 补偿」的 reasoning_content 反转案例——G2 数据
回填实证段后,working paper 升级 + packaging 下游。

# Note — 发布路径种子（等 G2/round-2 数据细化）

2026-07-05。状态:种子。两条路径为先后关系,顺序由证据状态决定。

## 路径 A · 解耦插件（地板,随时可发）

compaction-core 零依赖纯函数包 + adapter 集（pi extension 为第一个）。
G1a 架构的既有属性,无需新决策。发布物:`@ecode/compaction-core` +
`extensions/deterministic-compaction`（含 trust-protocol flag）。

## 路径 B · 「DeepSeek-first coding agent」（宣言,等数据）

定位与论文自洽:cache 契约绑定单一 backend 才跨层成立（multi-provider 是
论文反例）——ecode 即论点的演示物。但**成本承诺现在担不起**:

- 已知账:window 填满大大延后、单请求变小,但 CH 可见下降;
- DeepSeek 经济学恰以 hit 折扣 + 廉价 context 为卖点——净省在双模态
  分布下无先验答案;
- 纪律:C vs A 配对数字之前,不做任何节省率宣称（防「15-17%」重演）。

## 叙事排序（裁定）

**主叙事 = context 质量**:工作语义 vs 脏数据——任务完成度、注意力漂移
（代理:tool churn / off-task reads / re-read）、优势区间命中。
不依赖未决 cache 账;与「turn 分类判准 = 产品能力」一致;G2 复核表
（completion / 盲评 / re-read）即其测量面。
**成本叙事第二位**,带数据附注,round 2 后定稿。

## 产品约束（已定）

- **session 开始即开启**:ledger/视图溯源需完整历史,中途加入出处不明。
  开关语义:off→on 仅对新 session 生效,禁止热切。
- 手动开关先行（DF2 已有）,自动策略 = D4 dispatch policy,等交叉点数据。
- bash 结果不参与失配提示（无稳定 path→content 映射),只入 (c) 检测。

## 触发条件

G2 round 1 + round 2（C' 臂）双数据到位 → 复盘定稿:路径 A 立即发;
路径 B 若 cache 账为正或中性 → 全叙事发;若为负 → 只发质量叙事 +
诚实成本注记（负账本身是论文素材,不是发布障碍）。

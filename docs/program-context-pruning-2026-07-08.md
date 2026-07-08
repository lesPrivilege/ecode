# PROGRAM — Context 剪裁系统学：frontier 机制作为 thin-harness extensions

2026-07-08，Fable cowork pass。判权记录（操作者已裁）：① 收束形态 =
本纲领 + roadmap 北极星改笔；② B2 = thinking clearing；③ 对外口径
（README/Pages/resume）等 G4b+G4c 落地后切换。

## 0. 收束命题

ecode 收束为**对 context 剪裁的系统研究与实验**：把先进 harness 侧
乃至 provider 侧的剪裁机制，复刻为可运行在薄 harness（pi）与任意
OpenAI-compatible provider 上的 extensions，在同一台架上以三列账本
——**cache 价格 × 可复现性 × 失效指纹**——统一测量。

公开生态已列出 WHAT（机制菜单）；本程序的产出是每个 WHAT 的
price list、reproducibility class、failure fingerprint，以及一套可
移植的插件实现。三个机制来源自此归入同一谱系：

- **自研**：seam-A 确定性投影（C/C''）、seam-B 确定性 checkpoint
  ——已有受控数据（R2 终判、cache transition 曲线）；
- **harness 侧 frontier**：Claude Code / Codex 的修剪 pipeline 各层
  ——复刻对象；
- **provider 侧**：Anthropic context editing / server compaction、
  OpenAI compact endpoint——可复刻者复刻（TRC 已证同构），不可
  复刻者做行为探针与对照（PROBE-* 系列）。

## 1. 机制全录 × 可行性矩阵

对 frontier 调研十四机制（`note-landscape-compaction.md` 2026-07-08
增补节）按 pi 的缝分类。可行性等级：✓ 可复刻 / △ 有前置 / ✗ 结构性
不可复刻（只可对照）。

| 机制 | 缝 | 可行性 | 批次/状态 |
| --- | --- | --- | --- |
| send-time collapse（自研 C/C''） | seam-A | ✓ | **B0 已落**，R2 终判在案 |
| tool result clearing（Anthropic `clear_tool_uses`） | seam-A | ✓ | **B1 = G4**：core 已落版验收，adapter/遥测在分发 |
| thinking clearing（Anthropic `clear_thinking`） | seam-A | △ 前置核证 | **B2 = G5**：先核证 pi/DeepSeek 的 reasoning 回放行为（见 §3） |
| 初始上下文重注入（Claude Code survival table / Codex initial context injection） | seam-B + 注入位 | ✓ | B3 候选 |
| cache-aware pinning（microcompact） | seam-A + cache 位置估计 | △ 阻塞 | B4 候选；前置 = 发现 2 修复（遥测单位对账），否则「清在断点前/后」不可判 |
| 增量摘要（每 turn 更新） | seam-A | ✓ | 账本对照臂：**故意的最坏节奏**，为边界税提供参照系，非推荐机制 |
| LLM 全量摘要替换（`/compact` 同类） | pi 原生 | ✓ | 已在台（B 臂），作为解释执行基线 |
| 确定性 checkpoint（自研 seam-B） | seam-B | ✓ | B0 已落（hybrid 臂成分） |
| server compaction 复刻（`compact_20260112` 语义） | seam-B | ✓ 雏形已有 | 与 checkpoint 臂重叠度高，暂缓立批次；对官方行为走 PROBE |
| subagent 隔离 | 无缝可用 | ✗（pi 无 subagent 面） | upstream issue 候选（extension 无法自建隔离上下文） |
| memory-tool 联动预警 | 无缝可用 | ✗ 近似 △ | 依赖 memory 工具面；远期，不排期 |
| 远端 opaque compact（OpenAI `/responses/compact`） | — | ✗ | 只可对照：可审计性对照组，landscape 素材 |
| provider server-side compaction（Anthropic） | — | ✗ | PROBE 系列（count_tokens 探针已设计，PROBE-TRC §8.2 模式可扩展） |
| provider/model 分叉 compact（Codex 双路径） | — | ✗ | landscape 素材：failure economics 案例库 |

## 2. 统一管线（每批次同构，B1 已走通全程）

```
规格核证（官方 docs + SDK 类型面 + 先例复刻对照）
→ 分歧表 + 证据等级（已裁(推定) / 已证；PROBE 为升级路径）
→ 纯函数包（packages/*，零 harness 依赖，golden fixtures TDD）
→ 薄 adapter（extensions/*，pi 零 diff，mock 冒烟 + JSONL 落盘校验）
→ 遥测 + 指纹接线（schema 只增不改，FP-1 消费面）
→ 三列账本测量（对照臂 + 单参数价格扫描；run 判权归人）
```

管线自身的不变量（从 B1 提炼，后批次直接继承）：门控变量与被控
动作解耦（R3，发现 1 防复发线 + 负向测试）；恒等路径原引用
（prefix cache 契约）；placeholder/注入物为常量（byte-stable）；
复刻漂移登分歧表不静默（LangChain 样本为戒）。

## 3. B2 = G5 · thinking clearing（下一批次，前置核证先行）

复刻对象：`clear_thinking_20251015`——keep 最近 N 个 thinking turns
或 "all"；官方 cache 条款明确（keep 保 cache、clear 破点后）。
DeepSeek reasoner 场景的独有数据位：reasoning block 保留/清除的
cache 代价公开领域无测量。

**前置核证（G5-0，survey packet，先于一切设计）**：pi transcript 中
reasoning/thinking 的表示（`Message.thinking` 字段的实际填充路径）；
DeepSeek API 对历史中 reasoning 内容的回放规则（arch-c3 R2 曾记
「DeepSeek v4 reasoning-replay rules」——若 provider 强制丢弃回放
reasoning，则 DeepSeek 上该机制**已被 provider 内置**，复刻靶标
移到「保留侧」的对照测量，机制形态要反转）。此项不核证清楚不开
设计——B2 的可行性等级现在是 △ 不是 ✓。

## 4. 终局产出

1. **比较研究**：paper v2 增比较章——同台、同任务、同账本下的机制
   横评（自研 × frontier 复刻），每格三列标价；负结果照发；
2. **插件套件**：`@ecode/context-pruning` 逐批扩容 + 对应 extensions
   ——「boring to install, easy to disable」（roadmap 产品形态原句）；
3. **上游贡献**：不可复刻格转化为 upstream issue（subagent 面、
   cache 诊断）与 provider ask（server-side 能力、cache 字段），
   继承 `upstream-drafts` 纪律：只含可核验事实与窄 ask。

## 5. 纪律 carryover（不重述，只指名）

判权不下放（参数取值、run 预算、质量裁决归人）；pi 零 diff；
SWEEP-R2 冻结不受任何批次影响；对外口径切换点 = G4b+G4c 落地
（判权已裁）；「已裁(推定)」与「已证」的证据等级区分强制执行。

批次排期的解释权随每次判权轮更新，本纲领只锚定方向与管线形状。

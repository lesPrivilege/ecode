# G4 · Frontier Pruning Replica packets — TRC（tool result clearing）

2026-07-08，Fable 切分。上游：`docs/arch-frontier-pruning-design-2026-07-08.md`
（本文一切语义以它为准；packet 与设计冲突时停手报告）。分发纪律同
G0-G3：packet 自含、禁探索式阅读、判权不下放。

依赖图：G4a → G4b → G4c → EXP-TRC-*（run 轮，人分发，本文不含）。

---

## G4a · context-pruning 核心包（纯函数，TDD）

**输入**：设计文档 §1（参考规格）、§2 R1/R3/R4/R5、§3（包规格）、
§5 核心包测试清单、§8 分歧表；`packages/compaction-core/src/types.ts`
（Message/ToolCall 形状，import type 复用）。

**任务**：
1. 建 `packages/context-pruning/`（package.json、tsconfig、vitest，
   参照 compaction-core 同款布局）；
2. 实现 `clearToolUses(messages, config, deps)`，语义逐条对齐设计
   §3「语义细则」：toolCallId 配对、最老先清、trigger 严格大于激活
   （恰等阈值 = 恒等）、keep 对窗口、excludeTools（**不占 keep 名额**，
   D5 已裁）、clearAtLeast **all-or-nothing 适用门**（D8——注意：
   LangChain 同名实现是「清够即停」的止损预算，与官方明文相悖，
   **不得参照**，见设计 §8.1）、clearToolInputs 三态
   （false / true / string[]，D7）、preserveErrorResults 开关
   （默认 false，D4 已裁）、三处恒等路径全部返回**原数组引用**；
3. placeholder 为包内导出常量，不嵌任何变量内容（R5）；
4. report 形状 = 设计 §3 `ClearToolUsesOutcome.report` 逐字段；
5. 测试先行：设计 §5 核心包清单逐项成 golden fixture，全绿。

**产出**：独立可 import 的包；零 pi 依赖、零 provider 依赖、
对 compaction-core 仅 import type。
**验收**：§5 清单每项有对应测试且全过；恒等路径 reference-equality
断言在测；幂等与 byte-stable fixture 锚定在测；`npm test` 单命令全绿。
**禁区**：不改 compaction-core；不接任何 pi API；不自带 token 估计器
实现（只声明注入接口——估计器归 G4b）；不改设计文档（含分歧表——
发现规格矛盾时报告，不自行改约）。

> **状态（2026-07-08，Fable 验收）**：G4a 落版。Claude Code (Sonnet5)
> 执行，23 用例自报全绿 + Fable 独立 strip-types 冒烟 7/7 交叉证实
> （沙箱 npm 403 无法复跑 vitest，证据等级如实记录）+ 源码逐条审读。
> 执行中五个存疑点已裁：#1→D9、#2→§3 孤儿措辞修正（report 保真优先，
> 孤儿计数移交 G4c）、#3→D10（`ERROR_RESULT_META_KEY` 约定桥）、
> #4→D11（整对豁免）、#5→KNOWN-ISSUE G4a-5（build 已加 exit-1 护栏，
> `npm test`/`typecheck` 为验收口径）。导出面：`clearToolUses`、
> `CLEAR_TOOL_USES_PLACEHOLDER`、`ERROR_RESULT_META_KEY` + 全部类型。

---

## G4b · pi adapter extension + mock 冒烟

**前置**：G4a 落版全绿。
**输入**：设计文档 §2 R2/R3/R6/R9、§4、§5 adapter 段；
`extensions/deterministic-compaction/src/adapter.ts`（相对 import 复用，
R9；**勘误 2026-07-08**：从 frontier-pruning/src/ 出发为两级上跳
`../../deterministic-compaction/`，原文少写一级）、
`src/mock-provider.ts` + `test/smoke.test.ts` + `vitest.config.ts`
（**G4b-R 补入白名单**：alias 解法与真 loop 冒烟模板，见状态注记）；
`docs/g0-survey.md` Item 3（context hook 仅影响 send payload）。

**任务**：
1. 建 `extensions/frontier-pruning/`：`context` hook 注册，
   adapter 往返 + `clearToolUses` 调用，恒等时原引用透传；
   **D10 桥接**：adapter 必须把 harness 侧 tool result 的 isError
   填进 `meta[ERROR_RESULT_META_KEY]`（G4a 验收裁定，设计 §8 D10）；
2. 估计器实现并注入：chars/4 原始 transcript 单调度量（R3）；
   **禁止**引用 pi `estimateContextTokens` 或任何 provider usage 字段
   进门控——这是发现 1 的防复发线，须有负向测试（fixture 中植入
   usage 字段变化、断言门控读数不动）；
3. flags 面：设计 §4 七个 env var，默认全 OFF/官方默认值；
4. mock provider 冒烟：回放含 ≥6 个 tool use/result 对的固定序列，
   驱动 loop 验证阈上清除生效、阈下引用透传、session JSONL 逐字节
   未改写（落盘校验）。

**产出**：`extensions/frontier-pruning/`，对 pi 上游 diff = 0。
**验收**：冒烟跑通；开/关 flag 的 report 数字合理；JSONL 落盘校验过；
usage-解耦负向测试在册；adapter 复用无复制（import 路径为证）。
**禁区**：不 fork/patch pi core；不碰 deterministic-compaction 的任何
现有文件（只读 import）；不实装遥测 schema（归 G4c）；hook 能力不足
时报告而非绕过。

> **状态（2026-07-08，Fable 验收）**：G4b **有条件通过，一项返工
> （G4b-R）**。已过：pi 零 diff、deterministic-compaction 零改动、
> 28 用例自报全绿 + Fable 独立 strip-types 冒烟 8/8（R3 usage 解耦、
> 恒等引用、阈上清除、D10 桥、幂等、estimator 含 thinking）+ 源码
> 审读。八个存疑点裁定：#1 通过（fromCore 不可复用成立，恒等契约
> 检测是干净方案；该契约已由 Fable 补 pin 进
> `packages/context-pruning/test/identity-contract.test.ts`）；
> #2 通过（D10 白捡，独立冒烟证实）；**#3 否决**——「真 loop 做不到」
> 不成立：deterministic-compaction 的 `vitest.config.ts` alias 把
> `@earendil-works/*` 指向 `../../pi/packages/*/src`，其 `smoke.test.ts`
> 即真 `createAgentSession` + 真工具 + 真 JSONL 落盘校验、零 key。
> agent 在纪律内行事无过，**白名单缺陷在分发方**（未给这两个文件）；
> #4 成立，packet 已勘误；#5-#8 通过。
> **G4b-R（返工件，窄范围）**：照 DC 模板给 frontier-pruning 补
> vitest alias + 真 loop 冒烟（含 JSONL 逐字节落盘校验），其余产出
> 不动。
>
> **G4b-R 关闭（2026-07-08，Fable 验收）**：31/31 自报全绿；新冒烟
> 3 用例经源码审读通过——JSONL 校验为双向字节级（原文在档 + placeholder
> 零出现 + 单独解析 f0 条目），错误对用真 ENOENT + 早期捕获对比，
> 「reference→字节一致」换算论证有 g0-survey Item 3 依据且单元层 `===`
> 在册；src/ 经 grep 证实零 alias 依赖（jiti 装载兼容保持）；pi 围栏、
> DC、packages 全零改动。上轮存疑点 #3 的否决被返工实证支持（alias
> 补上后 mock-provider 立即可用）。**G4b 完全关闭**；沙箱无法复跑
> vitest（npm 403），证据等级 = 自报全绿 + 源码审读 + G4b 轮独立冒烟，
> 如实记录。

---

## G4c · 遥测 + 指纹接线

**前置**：G4b 落版。
**输入**：设计文档 §7；`docs/fingerprint-detectors-design-2026-07-08.md`
（FP-1 能力矩阵与判权纪律）；experiments/SCHEMA.md（只增不改）。

**任务**：
1. run JSONL turn 行增量字段 `trc: {applied, clearedToolUses,
   clearedInputTokensEst, gateReading}`；SCHEMA.md 同步登记（增量节）；
2. 被清 toolCallId→path 映射 sidecar ledger（path 取自配对 toolCall
   arguments；clearToolInputs=true 时记「path 不存活」标记）；
3. `cleared_path_re_reads` 计数接入现有 re-read 检测同路径；
   `meta.mechanism` 增 `"trc"` 取值，FP-1 (a) 检测器可消费；
   (b) 对 TRC 报 signal-absent（结构性不适用，设计 §7）。

**产出**：TRC run 产出的 JSONL 可被现有 report/FP-1 工具链直接消费。
**验收**：schema 校验器对新字段过；合成 fixture run 上 (a) 检测器
对 `cleared_path_re_reads` 触发正确；旧 corpus 回读不受影响
（向后兼容自查）。
**禁区**：不改 FP-1 参数档位；不产任何「结论性」数字（检测器结果
在参数定档前不得入结论——FP-1 判权纪律）。

> **状态（2026-07-08，Fable 验收）**：G4c 落版，**G4 完成定义达成**。
> 证据等级为 G4 系列最高：除 74/74 + 31/31 自报全绿与源码审读外，
> Fable 在沙箱**独立端到端复跑 T 臂 fixture run**（纯 node 链路不经
> vitest）——10 turns / projected=7 / `cleared_path_re_reads=1` 恰中
> refactor 场景天然重读点 / `compacted_path_re_reads=0` 证实臂隔离 /
> meta.mechanism.trc_installed+trc_config 完整。SCHEMA 纯增量经
> `git diff --numstat` 核实（20/0）。observer 与真 hook 共用同一
> trcEnv→parseTrcFlags→纯函数，无漂移面（run.ts:299-418 审读）。
> 存疑点裁定：#1 通过（零改动是「最小增量」的正解，G4a/G4b 导出面
> 设计得当的直接证据）；#2 通过（trc_installed 布尔 + trc_config 对象，
> 与 schema 现款式一致，设计 §7「取值」措辞按此理解）；#3 通过；
> #4/#5 通过但登债——死径清除计数与 toolCallId 级审计 ledger 为
> EXP-TRC-3 前置（已记入设计 §6）；#6 成立，SCHEMA.md 调用示例已由
> 验收方补 `--experimental-transform-types`（文档滞后修正，先于 G4c
> 存在）。

---

## 落 GOALS 与后续

G4 完成定义 = G4a+G4b+G4c 全落版且 `pi/` 保持零 diff。EXP-TRC-1/2/3
的 n、任务集、预算、排期为判权项，排在 SWEEP-R2 与 E1×C'' 队列之后
（设计 R10）。PROBE-TRC（设计 §8.2，Anthropic count_tokens 探针，
无采样成本）为可选证据升级件：D4/D5 从「已裁（推定）」升「已证」，
前置 Anthropic key，归人裁。后续机制批次（thinking clearing、cache-aware pinning、
初始上下文重注入）各自需要新的判权轮，不自动继承本 packet 授权。

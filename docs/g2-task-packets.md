# G2 Task Packets（草案，待人裁定）

2026-07-05。六个固定编号 packet：R（refactor）× 2、E（exploration）× 2、
D（direct-transformation，**负区间必跑**）× 2。模板沿用
`../taucode/docs/dogfooding-task-packets.md`（Goal / Read first / Allowed /
Non-goals / Validation / Acceptance / Review）。被试模型执行 packet，
四臂（A/B/C/D）× 同 packet 配对运行，经 `experiments/` 三入口记录与比对。

## 人侧输入清单（开跑前）

- [ ] credential：`DEEPSEEK_API_KEY`（cache 轴）或 Mimo OpenAI-compatible endpoint（token 轴），经 `experiments/lib/provider.ts` 配置位注入
- [ ] 本文六个 packet 逐个批改/裁定（尤其 Acceptance 行）——**本轮已做一次 dispatcher 复核，见各节修订记录**
- [ ] 质量复核：每对 run 后人工填复核表（见文末）
- [ ] **harness 缺口（2026-07-05 复核新发现，credential 到位也解决不了，需单独排期）**：
  - `experiments/fixtures/index.ts` 目前是硬编码单条目 registry（只有 `refactor` 一个合成 fixture），
    没有「读一个 G2 packet.md → 生成 `Scenario.prompt`」的转换器（taucode 原有等价物是
    `dogfood-task.mjs prompt --packet`）。R1/R2/E1/E2/D1/D2 六个 packet 目前都**无法**
    通过 `run.ts --scenario` 跑起来，这一步先补上。
  - `experiments/run.ts` 的 workspace 永远是新建的空 `tmpdir()`，只能靠
    `scenario.seedFiles`（小文件内容表）预置内容——没有「指向一个已存在目录（taucode
    快照）作为 cwd」的机制。R1/R2/D1/D2 四个 packet 依赖的「每臂从同一快照种子复制」
    协议（见下）目前没有代码支持。E1/E2 因为只读 `pi/`、产出写自己 workspace，受影响较小
    但也需确认 pi 的 read 工具能否读 cwd 之外的绝对路径（未验证）。
  - 好消息：provider 可插拔的架构本身是对的——`resolveProvider` 的 mock/real 分支设计、
    `session.prompt()` 驱动执行的方式都与「真模型自主决策」兼容，不需要推倒重来，
    缺的是这两块具体的桥接代码，不是架构问题。

## 运行协议

1. **workspace 隔离**：R/D packet 在 `experiments/workspaces/<packet>-<arm>/` 里跑，
   每臂从同一快照种子复制（`../taucode` 去 `.git`、去 `results/`；`npm install` 后快照，
   保证四臂起点字节一致）。E packet 以 `pi/` 为只读对象，产出写在自己 workspace。
2. **臂序随机化**：同 packet 四臂的执行顺序打乱，避免 provider 侧时间性偏置（cache TTL）。
   **落地方式（2026-07-05 补，`plan.ts` 目前按 `--arms` 给定顺序原样输出，不自动打乱）**：
   `plan.ts` 尚未实现随机化，在此功能补上之前，人工分发时对每个 packet 用
   `shuf -e A B C D | paste -sd, -` 生成一次顺序，作为该 packet 的 `--arms` 参数值
   记入运行清单（六个 packet 各自独立随机一次，不要复用同一顺序）。
3. **参数**：推荐参数 `keep=3` / `compact-after=32k` 全 packet 必跑；
   sweep（4k/16k/32k/64k）只加跑 **R1 与 D1**（优势区/负区各取一个代表，控制成本）。
4. **判定门自动执行**：compaction 未触发 → invalid（加大任务或降阈值重跑并记录）；
   token 省但 churn/re-read 升 → suspicious 标记，不进正面证据。
5. **记录**：每 run 一个 JSONL（G1c schema），run 目录名 `<packet>-<arm>[-sweep<N>]`。

## Packet 索引

| ID | 类 | 对象 | 预期落区 | 主要考察 |
| --- | --- | --- | --- | --- |
| G2-R1 | refactor | taucode `compaction.ts`（910 行）拆分 | 优势区 | 曲线 B（工作产物压缩） |
| G2-R2 | refactor | 补 `artifacts.ts`/`compaction-report.ts` 测试 | 优势区 | 读-写循环 |
| G2-E1 | exploration | pi extensions+session 子系统地图 | 优势区 | 曲线 A（orientation 折旧） |
| G2-E2 | exploration | usage/cacheRead 数据流追踪 | 优势区 | 跨大文件读 |
| G2-D1 | direct-transform | compaction.ts 逐符号 line-cited 参考 | **负区** | 精确原文依赖 |
| G2-D2 | direct-transform | 全导出函数补显式返回类型 | **负区** | 精确签名依赖 |

---

## G2-R1 · 拆分 compaction.ts（保持公开 API）

Goal：把 910 行的 `packages/core/src/compaction.ts` 拆为 `compaction/strategies.ts`
（各 tool 策略与 `DEFAULT_TOOL_COMPACTION_STRATEGIES`）与 `compaction/projection.ts`
（`compactCodeProductions` 与投影机制），原路径变薄 re-export，公开 API 与行为零变化。

Read first：`packages/core/src/compaction.ts`、`packages/core/src/index.ts`、
`packages/core/test/compaction.test.ts`
Allowed：`packages/core/src/compaction.ts`、`packages/core/src/compaction/`、`packages/core/src/index.ts`
Non-goals：不改任何策略逻辑/阈值/summary 结构；不动 `compaction-report.ts`；不改测试断言。

Validation：`pnpm test -- packages/core/test/compaction.test.ts`；`pnpm run typecheck`

Acceptance：
- file-exists packages/core/src/compaction/strategies.ts
- file-exists packages/core/src/compaction/projection.ts
- contains packages/core/src/compaction.ts :: export
- regex packages/core/src/compaction.ts :: from "\./compaction/
- command: pnpm test -- packages/core/test/compaction.test.ts
- command: pnpm run typecheck

## G2-R2 · 补 artifacts 与 compaction-report 的单元测试

**修订记录（2026-07-05，dispatcher 复核）**：原稿目标 `read-dedup.ts`/`accumulator.ts`
的前提「无测试文件」经核对为假——两文件的测试早在 5-27/5-28 就已存在
（`packages/core/test/{read-dedup,accumulator}.test.ts`，分别 11/13 条断言，非空壳），
不是本轮新出现的变更。按原稿跑会让被试在零实际工作量下于 file-exists 检查上
直接"通过"，产不出任何读-写循环信号。改用 `packages/core/src/artifacts.ts`
（85 行，`ArtifactRegistry` 类 + 工厂函数）与 `packages/core/src/compaction-report.ts`
（205 行，`projectCompaction`/`buildCompactionReviewPayload`/两个 format 函数）——
两者均已核实**当前确实没有**对应测试文件，合计 290 行，与原稿 323 行体量相当。

Goal：为 `artifacts.ts`（85 行）与 `compaction-report.ts`（205 行）各写一个测试文件，
覆盖公开导出的主路径与至少两个边界（空输入、重复键/越界之类，以模块实际语义为准）。

Read first：`packages/core/src/artifacts.ts`、`packages/core/src/compaction-report.ts`、
`packages/core/test/compaction.test.ts`（风格基准）
Allowed：`packages/core/test/artifacts.test.ts`、`packages/core/test/compaction-report.test.ts`
Non-goals：不改 src；不引入新依赖；不为凑数写恒真断言。

Validation：`pnpm test`

Acceptance：
- file-exists packages/core/test/artifacts.test.ts
- file-exists packages/core/test/compaction-report.test.ts
- regex packages/core/test/artifacts.test.ts :: describe\(
- regex packages/core/test/compaction-report.test.ts :: it\(
- command: pnpm test

## G2-E1 · pi extensions + session 子系统地图

Goal：产出 `SUBSYSTEM-MAP.md`：pi 的 extension 生命周期（发现→加载→注册→hook 派发）
与 session 持久化（entry 类型、compaction entry、branch）两个子系统的结构地图，
每个关键论断带 `file:line` 引用。

Read first：`pi/packages/coding-agent/src/core/extensions/`（types/loader/runner/wrapper）、
`pi/packages/agent/src/harness/agent-harness.ts`、`pi/packages/agent/src/harness/session/`
Allowed：workspace 内 `SUBSYSTEM-MAP.md`（只产出这一个文件）
Non-goals：不改 pi 任何文件；不评价设计优劣；不复述 g0-survey 已有内容以外须新读源码。

Validation：人工抽查 ≥5 处 file:line 引用与源码一致。

Acceptance：
- file-exists SUBSYSTEM-MAP.md
- regex SUBSYSTEM-MAP.md :: extensions/loader\.ts:\d+
- regex SUBSYSTEM-MAP.md :: agent-harness\.ts:\d+
- regex SUBSYSTEM-MAP.md :: ## .*[Ss]ession
- not-contains SUBSYSTEM-MAP.md :: TODO

## G2-E2 · usage/cacheRead 数据流追踪

Goal：产出 `CACHE-FLOW.md`：从 provider 原始 usage 字段（含 DeepSeek
`prompt_cache_hit_tokens`）到 `usage.cacheRead` 再到 session/显示层的完整数据流，
每一跳带 file:line，含中途的归一化/减法（input 扣除 cacheRead 的位置）。

Read first：`pi/packages/ai/src/api/openai-completions.ts`、
`pi/packages/ai/src/providers/deepseek.ts`、`pi/packages/agent/src/`（usage 消费侧自行定位）
Allowed：workspace 内 `CACHE-FLOW.md`
Non-goals：不改 pi；不推测未读代码的行为——每个论断要么有引用要么标注「未证实」。

Validation：人工抽查全部 file:line。

Acceptance：
- file-exists CACHE-FLOW.md
- regex CACHE-FLOW.md :: prompt_cache_hit_tokens
- regex CACHE-FLOW.md :: openai-completions\.ts:\d+
- regex CACHE-FLOW.md :: cacheRead

## G2-D1 · compaction.ts 逐符号 line-cited 参考（负区探针）

Goal：产出 `COMPACTION-REFERENCE.md`：`packages/core/src/compaction.ts` 中**每一个**
导出符号的条目——签名逐字抄录、起止行号、一句功能描述。910 行文件的穷举式
精确转写，故意构造对原文的持续依赖。

Read first：`packages/core/src/compaction.ts`
Allowed：`COMPACTION-REFERENCE.md`
Non-goals：不改 src；不摘要代替逐字签名；不跳过任何导出。

Validation：人工抽查 ≥8 个条目的签名与行号逐字核对；导出计数核对见下。

**Acceptance 修订记录（2026-07-05，dispatcher 复核）**：原稿的自动数条目 command 是
`node -e "..."` 内联脚本——核对 taucode `scripts/dogfood-task.mjs` 的
`SAFE_COMMAND_PREFIXES` 后确认它不在允许列表内（只放行 `node --check`、
`node scripts/dogfood-task.mjs`、`node scripts/dogfood-p0.mjs compare`、两个特定
`packages/tui/dist/cli.js` 调用、`pnpm run typecheck`、`pnpm test`、`pnpm --filter`），
会被 `isSafeAcceptanceCommand` 静默判否，即这条防跳过检查实际上**不会执行**。
两条路径二选一，留给你定：(a) 降级为下面的人工核对步骤（简单但失去自动化）；
(b) 在 ecode 侧维护一份带扩展 allowlist 的 dogfood-task.mjs 变体，随快照一起复制到
workspace（不改真实 taucode，但是新工程量，未开始）。本稿先按 (a) 处理。

Validation（补充）：跑
`node -e "const fs=require('fs');const src=fs.readFileSync('packages/core/src/compaction.ts','utf8');const n=(src.match(/^export /gm)||[]).length;const doc=fs.readFileSync('COMPACTION-REFERENCE.md','utf8');const m=(doc.match(/^#{2,3} /gm)||[]).length;if(m<n)throw new Error('entries '+m+' < exports '+n)"`
——人工执行，不进自动 Acceptance 门。

Acceptance：
- file-exists COMPACTION-REFERENCE.md
- regex COMPACTION-REFERENCE.md :: compactCodeProductions
- regex COMPACTION-REFERENCE.md :: DEFAULT_TOOL_COMPACTION_STRATEGIES
- regex COMPACTION-REFERENCE.md :: L\d+[-–]L?\d+

## G2-D2 · 全导出函数补显式返回类型（负区探针）

Goal：给 `packages/core/src/compaction.ts` 与 `packages/core/src/loop.ts`（合计 ~1740 行）
中每个缺显式返回类型的导出函数补上精确返回类型注解。机械、跨全文件、
每处都需要当时的精确签名——直接转换型工作流的标准形态。

Read first：`packages/core/src/compaction.ts`、`packages/core/src/loop.ts`、`packages/core/src/types.ts`
Allowed：仅上述两个 src 文件的类型注解位置
Non-goals：不改逻辑/控制流/导出集合；不用 `any`/`unknown` 搪塞；不动非导出函数。

Validation：`pnpm run typecheck`；`pnpm test`；`git diff --stat`（改动应只有两个文件）

Acceptance：
- command: pnpm run typecheck
- command: pnpm test
- not-regex packages/core/src/compaction.ts :: ^export (async )?function \w+\([^)]*\)\s*\{
- not-regex packages/core/src/loop.ts :: ^export (async )?function \w+\([^)]*\)\s*\{
- not-regex packages/core/src/compaction.ts :: \): (any|unknown)\b
- not-regex packages/core/src/loop.ts :: \): (any|unknown)\b

（补充说明：后两条只挡得住字面 `any`/`unknown` 标注，挡不住更隐蔽的绕过方式
（如 `as` 断言或刻意宽泛的联合类型）——机械检查的天花板，Non-goals 里的
「不用 any/unknown 搪塞」最终仍需 Validation 的人工复核兜底。）

---

## 复核表（每对 run 人工填，沿用 taucode Review Form 加两项）

- completion：done / partial / failed（四臂各记）
- 质量：C/D 臂产物与 A 臂**盲评**比较（same / better / worse / unclear；建议去标识后混评）
- re-read：次数 + compacted-path re-read 率（G1c 自动出）+ 是否可解释
- token：四臂总 input/output；B/D 臂 summarizer in+out 单列
- cache：cacheRead 曲线（DeepSeek 轮）——D1/D2 重点看 transition 后是否恢复稳态
- 判定门：invalid/suspicious 标记逐条确认或推翻（推翻要写理由）
- next：keep / tune / split / block

## 成本与止损

**预算公式修订（2026-07-05，dispatcher 复核）**：原式对 sweep 段按 4 臂计，但
`run.ts` 里 `compactAfterInputTokens`/`keepRecentAssistantMessages` 只在
`arm.seamAInstalled` 时才读取（见 `experiments/run.ts` 注释与 `lib/arms.ts`）——
A、B 两臂结构上不吃这个参数，扫它们等于把同一个基线 run 复制 3 份，纯浪费。
sweep 段应只跑 C、D：

全量 = 6 packet × 4 臂 + 2 packet × 3 额外 sweep 点 × 2 臂（仅 C/D）= 24 + 12 = 36 run
（原式 48 run 高估，其中 12 run 是 A/B 的冗余重复）。

若预算紧：先跑 R1/E1/D1 × 4 臂（12 run）作首轮，D1 若未复现负区特征
（re-read 率显著高于 R/E）则 D2 提前替补。止损条款按
`roadmap-context-economy-2026-07.md` 第四节执行。

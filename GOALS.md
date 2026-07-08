# Goal 切分 — ecode：context 经济验证台（本 repo 为工作根）

2026-07-05。上游依据：`docs/roadmap-context-economy-2026-07.md`（已收束入本 repo）。
布局：`pi/`（上游 fork，G0 建立）、`packages/compaction-core/`（G1a）、
`extensions/`（G1b）、`experiments/`（G1c）、`docs/`（携带文档 + survey）。
taucode 本体在兄弟目录 `../taucode/`，只读引用，不改。
分发模式：每个 Goal 一个 Opus/Codex agent，packet 自含（精确文件清单 + 验收标准 +
禁区），禁探索式阅读。判权不下放：参数取值、质量复核、判定门裁决归人。

依赖图：G0 → G1a‖G1b 前半 → G1b → G1c → G2（执行轮，人分发）

> **状态 2026-07-06**：G0-G1e、DF1-DF2、V2-TP、G3-AR、V3-WS 均已落版；
> `pi/` 对 upstream 仍保持零 diff。R2 core 27 run + B' add-on 9 run
> 已完成，`docs/reports/r2-verdict.md` 给出终判；R1-C artifact 已人工
> 盲评补记。当前待办转为：① R1-C/D1-C sweep 缩编轮 ② E1 × C''
> 语义锚点追加轮 ③ 发布/申请材料定稿与长期路线维护。R2 后续
> 已补齐 turn 级复盘、LLM-declared work semantics、extension 解耦
> 架构评估与 Fable cowork outcome；设计包已落在
> `docs/arch-c3-design-2026-07-06.md`，分发链从 WS-0/WS-1 开始。

---

## G0 · fork 与重摸底（先行，阻塞一切）

**输入**：https://github.com/badlogic/pi-mono （fork/clone 到本文件夹 `pi/`）
**任务**：
1. clone 最新 main，装依赖，跑通 `pi-coding-agent` 基本 loop（任一 provider）。
2. 重新核对四项（6 月读数已过期两周+，以现源码为准，逐条给 file:line 引用）：
   - `read` 工具输出格式（`packages/coding-agent/src/core/tools/read.ts`）——有无 path/hash 结构；
   - extension 注册 API 确切签名（`src/core/extensions/` + 根 `examples/extensions/`）；
   - `context` hook（原 `agent-harness.ts` transformContext）：签名是否仍为
     `AgentMessage[] → {messages?}`；返回值是否影响 session 持久化（预期仅 send 投影不落盘，须验证）；
   - `session_before_compact` hook 是否仍可返回 `{compaction}` 替代原生 LLM compact；
   - pi-ai 对 OpenAI 兼容 endpoint 的 cache 字段透传（DeepSeek `prompt_cache_hit_tokens` 会不会被丢弃）。
3. 记录 pi 原生 compaction 现参数（reserveTokens/keepRecentTokens 默认值是否仍为 16384/20000）。

**产出**：`pi/` 可运行 + `docs/g0-survey.md`（每项含 file:line）
**验收**：五项全部有答案；任何与 6 月文档不符处显式标注 DRIFT。
**禁区**：不改 pi 源码；不开始移植。

## G1a · compaction externalization（与 G0 并行）

**输入**（路径已确认）：
- `../taucode/packages/core/src/compaction.ts`
- `../taucode/packages/core/src/compaction-report.ts`
- `../taucode/packages/core/test/compaction.test.ts`（26 用例）
- `docs/taucode-wrapup-2026-06.md` Part 2 搬/改/弃清单。
**任务**：把纯函数模块解耦为独立包 `packages/compaction-core/`（放本文件夹）：
1. `strategies` 注入替代硬编码 `DEFAULT_TOOL_COMPACTION_STRATEGIES`；
2. tool-name 匹配函数注入；
3. path/hash 提取函数注入（hashline `¶path#hash` 退化路径：path+行数）。
算法与投影语义一字不动；26 个测试全绿 + 为三个注入点补新测试。

**产出**：独立可 import 的包，零 pi 依赖，零 taucode-harness 依赖。
**验收**：原测试全过；新注入点测试；`projectCompaction()` 报告 shape 不变。
**禁区**：不改算法；不做 proxy；不发 npm。

## G1b · pi extension + adapter（依赖 G0 + G1a；已按 g0-survey 修订）

**前置**：ecode 根 `git init`（agent 产出须可 diff 审计）。无需 provider 真 key（见任务 4）。
**输入**：本 packet + `docs/g0-survey.md` + `docs/taucode-on-pi-integration.md` 第 3 节 + `packages/compaction-core/` 的公开 API。

**任务**：
1. `Message ↔ AgentMessage` adapter：对照集成文档第 3 节映射表 + survey 实测签名。assistant toolCall block ↔ toolCalls[]，toolResult(content blocks, isError, toolCallId) ↔ result message，配对按 toolCallId 重写。
   **survey 修正（Item 1）**：pi 的 read 结果是纯文本，**无 path 前缀、无 hash、无 hashline**。path/hash 提取注入必须走降级路径：path 从**配对 toolCall 的 arguments**（`{path, offset?, limit?}`）取，hash 对 result text 现算（或退化为 path+字节数）。不得假设结果文本里有 `¶path#hash`。
2. extension 注册 `context` hook（缝 A）：factory 签名 `ExtensionFactory = (pi: ExtensionAPI) => void`（types.ts:1447），模板在 `pi/packages/coding-agent/examples/extensions/`（DRIFT：不在 repo 根）。hybrid 门控保留——门下**原样返回**保 prefix cache，跨门投影。survey Item 3 确认 hook 每次 LLM call 都跑且仅影响 send payload：投影必须幂等（compaction-core 已是）且有性能预算（大 message 数组下的耗时上限）。token 估计复用 pi 侧现成值，禁止另造 4-char 估算。
3. （可选，缝 B）`session_before_compact` 返回 `{compaction}`，参照 `examples/extensions/custom-compaction.ts:114-120` 模板；feature-flag 关默认。注意 `fromHook: true` 入档后，pi 下次 compaction 会跳过其 details 的 file-op 提取（compaction.ts:43）——checkpoint summary 须自含。
4. **冒烟不依赖真 key**：用 `pi.registerProvider`（types.ts:1360）注册一个 scripted mock provider，回放固定 toolCall/结果序列，驱动 loop 穿过 context hook 验证投影与配对。live round-trip 留给 G1c（届时人提供 DeepSeek/Mimo key）。

**产出**：`extensions/deterministic-compaction/`，对 pi 上游 diff = 0（纯 extension）。
**验收**：mock provider 冒烟跑通；开/关 extension 的投影报告数字合理；session JSONL 原始历史未被改写（落盘校验）；adapter 对 read 降级路径有专项测试。
**禁区**：不 fork/patch pi core；不碰 `../taucode`；发现 hook 能力不足时报告而非绕过。

## G1c · 四臂实验 harness（依赖 G1b）

**任务**：run 脚本 + 报告器，四臂同台：
| 臂 | 配置 |
| --- | --- |
| A | 原生 compaction 关 + 无 hook |
| B | pi 原生 LLM-summary（summarizer in+out 计入成本） |
| C | G1b extension（推荐参数 keep=3 / compact-after=32k，参数可 sweep） |
| D | 门下 C + 跨阈值缝 B checkpoint |

指标每 run 落 JSONL：总 input/output token、tool-call 数、re-read 数、
**compacted-path re-read 率**（引用追踪：被压缩 path 的后续 read 事件）、
provider cache hit/miss（survey Item 5 确认：DeepSeek `prompt_cache_hit_tokens` 经 pi-ai 映射为 `usage.cacheRead`，直接取；无则显式 null）、completion 占位字段（人工填）。
判定门代码化：未触发→invalid；token 省但 churn 升→suspicious 标记。

**产出**：`experiments/`（plan/run/compare 三个入口，对齐原 dogfood-p0.mjs 语义）。
**验收**：四臂各跑一个冒烟 packet，报告可比对；sweep 参数化（4k/16k/32k/64k）。
**禁区**：不自造 task packets 内容（G2 人定）；不下质量结论。

## G1d · packet-loader 与 workspace 快照桥接（依赖 G1c；阻塞 G2 全部六个 packet）

背景：G1c 复核发现两个 harness 缺口（见 `docs/g2-task-packets.md` 人侧输入清单）。
架构裁定（人定，终稿）：**快照构建外置，per-arm 复制内置**。

**任务**：
1. `experiments/lib/packet.ts`：解析 taucode packet 格式（Goal / Read first /
   Allowed / Non-goals / Validation / Acceptance）→ `Scenario`。prompt 生成语义
   对齐 `../taucode/scripts/dogfood-task.mjs` 的 `prompt --packet`（先读它，
   不重造转换规则）。六个 G2 packet（`docs/g2-task-packets.md`）全部可加载。
2. acceptance 静态检查（file-exists / contains / not-contains / regex / not-regex）
   在 run 结束后自动执行，逐条结果写入该 run 的 JSONL（`accept: [{check, pass}]`）；
   `command:` 类不自动执行，原样记录为 `pending`（allowlist 纪律，人工/compare 层处理）。
3. `experiments/prepare-snapshot.ts`：构建 packet-class 快照（复制 `../taucode`
   去 `.git`/`results`/`node_modules` → `npm install` → 记录内容 manifest hash），
   输出到 `experiments/snapshots/<name>/`。贵操作，per-packet-class 一次。
4. `run.ts` 新增 `--workspace-from <snapshot-dir>`：把快照廉价复制为本 run 工作目录，
   并在 JSONL 里自记 `workspace: {source, manifestHash}`——「四臂起点字节一致」
   变成可核验字段而非协议承诺。缺省行为（tmpdir + seedFiles）保持不变。
5. 实证确认 pi read 工具对 cwd 外绝对路径的行为（E1/E2 依赖读 `pi/` 源码），
   结论以 file:line 补进 `docs/g0-survey.md` Item 7；若受限，给出 E packet 的
   最小落法（symlink 或调整 cwd），不改 pi。

**产出**：上述两个新文件 + run.ts/JSONL schema 增量 + survey Item 7。
**验收**：六个 G2 packet 逐个 `packet.ts` 加载成功且 prompt 与 dogfood-task.mjs
语义一致（抽查对比）；mock provider 下用快照 workspace 跑通一个 R 类冒烟，
JSONL 含 workspace hash 与 accept 字段；两臂同快照的工作目录 diff 为空。
**禁区**：不改 G2 packet 内容；不动 pi；不动 compaction-core 算法；
不自动执行 `command:` 检查。

## G1e · real-provider wiring（小；阻塞 G2 执行与 DF0）

背景：`experiments/lib/provider.ts` 的 `resolveProvider` 只有 `"mock"` 分支——
real 路径是 G1c/G1d 留下的显式 future work，是 pipeline 最后一块桥接代码。

**任务**：
1. `resolveProvider` 加 `"deepseek"` 分支：接 pi 原生 provider
   （`pi/packages/ai/src/providers/deepseek.ts`，openai-completions API，
   `DEEPSEEK_API_KEY` env 认证），不自建 provider。
2. 同法加 OpenAI-compatible 泛型分支（baseUrl + model + env key 三参数），
   覆盖 Mimo 类 endpoint。
3. real 分支置 `cacheSignalPresent: true`，`usage.cacheRead` 真实记录
   （mock 分支保持 null 语义不变）。
4. key 缺失时报错信息明确指出所需 env 变量名；**不在任何文件/日志/JSONL 里
   落 key 本体**。

**验收**：mock 冒烟回归不破；`DEEPSEEK_API_KEY` 未设时 real 分支给出清晰报错
（这是无 key 环境下唯一可测路径）；代码审查确认 key 不落盘。
**禁区**：不改 pi；不动 mock 语义；不发真实请求（无 key 环境）。

---

# DF · dogfooding 切分（依据 docs/roadmap-dogfooding.md，可与 G2 执行并行）

依赖：G1e → DF0（人侧）→ DF1 → DF2 → DF3。
（2026-07-05 修正：原定 DF1‖DF2 并行，dispatcher 复核发现 DF2 的调参事件
依赖 DF1 的 ambient JSONL 写入器——串行化，DF1 导出稳定签名的 writer 供
DF2 调用，禁止第二个 writer 实现。）DF 系列全部是 extension/experiments
增量，不碰 pi core，与 G2 的 workspace 隔离互不干扰。

## DF0 ·（人侧，非 coding）日常基线

key 入 shell env；全局 `~/.pi/agent/extensions/` 挂 deterministic-compaction；
推荐参数为默认；日常用一周，只记「哪里不顺手」。

## DF1 · compaction 可观测性 extension 增量

**任务**：`/compaction` 命令族（status / diff / report，数据源
`projectCompaction()` 报告 shape，移植 taucode 三命令语义）；
registerMessageRenderer 渲染触发标记线（turn 号、压缩量、门控位置）；
ambient telemetry——每 session 落 G1c schema JSONL 到
`experiments/results/ambient/`（默认开，`/compaction telemetry off` 可关）。
**验收**：mock session 里三命令输出正确；触发标记线在触发 turn 可见；
ambient JSONL 与 G1c schema 校验通过。
**禁区**：不改投影逻辑；telemetry 不出本机、`results/ambient/` 入 .gitignore。

## DF2 · runtime 调参命令

**任务**：`/compaction set keep-recent=N|compact-after=N`（写回 project
settings，下一 turn 生效）；`/compaction on|off`（负区逃生门）；每次调参
事件记入 ambient JSONL（时间、旧值→新值、当时 contextTokens）——这是
runtime policy 自动化的样本源。
**验收**：调参后下一 turn 投影行为随之变化（mock 可测）；事件记录完整。
**禁区**：不做自动策略（只做手动 + 记录）。

> **实证发现（2026-07-05，DF2 完成时）**：`ExtensionAPI`/`ExtensionContext`
> 无 settings 读写面——「写回 project settings」在 extension 层无干净落点，
> 且 extension 自身参数是 factory 时一次性读 env，持久值也不会回流。
> 落法改为 opt-in sidecar（记录、不回读），按「hook 能力不足时报告而非绕过」
> 纪律处理。这是外化天花板的又一实例：extension 层够不到 settings 层，
> session 内调参可行，跨 session 持久化需要上游（pi）暴露接口——已是
> 论文素材，也是将来给 pi 上游提 issue/PR 的候选。

## DF3 · MCP bridge（后置，范围硬边界）

`registerTool` 代理 MCP server tools（stdio + @modelcontextprotocol/sdk client
起步）；tool specs 注入稳定前缀区，server 列表变更视同前缀重置。
**只支持自用 1-2 个 server**，不做通用聚合器。等 DF0 一周试用明确
「缺哪个工具」后再定目标 server，不预先开工。

## V2-TP · trust-protocol 切片（Opus 执行;核心 harness 改动）

依据：`docs/note-view-based-context.md` 信任协议节 + DF0 双模态收口
（(d) 判别器:`re_reads>0` 且 `compacted_path_re_reads≈0`）。
原则重申:**harness 只注入可机械验证的事实,永不注入信心。**

**基线纪律（最高优先约束）**：全部改动置于 feature flag
`ECODE_TRUST_PROTOCOL`（默认 **off**）之后。G2 round 1 的 C 臂必须在
flag-off 下与 v1 字节等价——round 2 才开 C' 臂（flag-on）对照。

**任务**（移植 + 接线为主,发明为辅;taucode 机件清单已核实存在）：
1. **视图登记**：extension 监听 read/bash tool result 事件,记
   `path → {contentHash, turn}` 于 session 内存 ledger（不落盘、不改
   result 本体）。hash 算法对齐 taucode hashline（SHA-256 截断）。
2. **edit 物证保全**：edit/write result 事件时计算落盘后文件 hash,记入
   ledger（`path → {newHash, turn, diffstat}`）;compaction-core 的
   CodeProductionSummary 已保 path/head/tail——扩展 injection 使投影后
   summary 必含 `hash + diffstat`（G1a 注入点,不改算法主体）。
3. **失配提示注入**：context hook 投影时,对 context 中「出生 hash ≠ 当前
   ledger hash」的视图,在 **volatile 尾区**追加一个确定性提示块:
   `[stale-view] <path>: view from <hashA> predates your edit at turn <N>
   (now <hashB>); re-read only if you need current content.`
   仅 send-time,不入 session;置于尾区不破前缀。每 path 每 turn 至多一条。
4. **read-dedup 接线评估**：taucode `read-dedup.ts`（已建未接线）作为
   循环病理 (c) 检测器移植到 extension 侧——本任务只做**评估 + 最小接线
   方案**,实报告,不实装（防 scope 蔓延）。

**验收**：
- flag-off:与 v1 全部现有测试字节级同行为（回归全绿即证）;
- flag-on 单测:hash 相同不注入;hash 不同注入且格式精确;edit summary
  投影后含 hash+diffstat;提示块位于尾区（前缀稳定性测试);
- mock 场景重放:构造「edit 后读到旧视图」fixture,flag-on 时模型输入里
  出现 stale-view 行;
- **效果证伪路径**（round 2 执行,本轮只留观测钩子):歧义编辑任务上
  (d) 率 flag-on/off 对比,ambient 记 flag 状态。
**禁区**：不碰 `pi/`;不改 compaction-core 投影算法主体（只经注入点);
不注入任何非文件系统可验证的语句;flag 默认值不得为 on。

## DF-TUI · compaction 可视化 TUI（新分发模式:Opus 切片,DS 实现,Opus 兜底）

动机:TUI 是策略奏效/失效最直观的展面,也是对外示值最短路径——
将来 README 或推文串里的那几张截图,就从这条总验收里出。
地基已有:`gate-widget.ts` 的 `renderGateWidget` 纯函数 + 7 个测试;
DF1 的 observability 三命令（status/diff/report）+ 触发标记线;
V2-TP hint、compaction 触发、CH 数据全部可从 extension 侧取到。

**分发模式（本 goal 首试）**:Opus 把工作切成小 loop 交 DS 实现
（DS base model 可承接稍重切片）,Opus 逐片审收 + 兜底修复。

### 围栏（每条 DS prompt 原文携带,不引用不省略）

> **围栏正文**:只改 `extensions/` 下文件;`pi/` 目录任何文件只读——
> 不 import、不修改、不新建 pi 源码;TUI 渲染一律经
> `ctx.ui.setWidget` / `registerMessageRenderer`,禁止直接写 pi 的
> interactive-mode 或任何 core 模块。
>
> **案底（L3 违规,2026-07-05）**:DS 在实现 compact-gate-widget 时
> 漂进了 pi core——把 widget 注册代码写进了
> `pi/packages/coding-agent/src/interactive-mode.ts`。该违规被人拦截
> 回滚,但证实了 DS 在被指向 `pi/` 内文件做只读核对时,会顺手修改
> 目标文件。围栏因此必须在 prompt 里,不能依赖 session 先前轮次或文档
> ——DS 没有契约记忆。

### 数字口径（F-A 裁定,锁死）

gate widget 的 `rawTokens` 是 **compactable-content 估算**（projection.ts
逐条累加 tool-result 文本）,不是 context 总量（含 system prompt、tool
definitions、user turns 等,量级差可达 ~100x）。TUI 任何展示数字的位置
必须标注口径:

- `compactable` 标签:gate 阈值、savings、rawTokens——都是 compactable
  scale
- `context` 标签:仅当展示 provider 返回的 `usage.input` 或估算的
  context 总 token 时使用

两个口径**永不相加、永不相除**。违反即 bug,不是样式问题。
`observability.ts:184-189` 已有 F-A 标签先例（`compactable-content
estimate`）,新增渲染沿用同一措辞。

### 功能切片（Opus 按此拆 loop,可再细分）

**S1 · gate 状态条**（完善现有 `gate-widget.ts`）
- 展示:门控位置（compactable / threshold）、waiting / active / off、
  当前生效参数 keep-recent 和 compact-after
- 数据源:`gateStatus` singleton（seam-A 每 turn 更新）
- 验收:纯函数 `renderGateWidget` 覆盖全部 triggerState 分支 + 参数
  回显;数字标注 `compactable` 口径;extension 回归绿;`pi/` 零 diff

**S2 · 触发标记线**（增量:observability trigger marker 的 TUI 化）
- 展示:compaction 实际触发 turn 的可见标记 + 该次 replacements 数 +
  省下 token 数（compactable scale）
- 数据源:seam-A hook 触发时的 `CompactionProjectionReport`
  （`report.replacements.length` / `report.savedTokens`）
- 渲染路径:`pi.sendMessage({ customType })` + `registerMessageRenderer`
  （同 DF1 既有模式,仅改渲染文本）
- 验收:触发 turn 可见标记包含 replacement 数和 saved token 数;
  未触发 turn 无标记;纯函数测试

**S3 · CH 轨迹微条**
- 展示:近 N turn（N=10 或可配）的 cache-hit ratio（`cacheRead /
  (cacheRead + input)`）走势,transition dip 可见即达标
- 数据源:provider `usage.cacheRead`（pi-ai 映射自
  `prompt_cache_hit_tokens`）;每 turn `message_end` 事件采集
- 存储:session 内存 ring buffer（`{turn, ratio}[]`）,不落盘
- 渲染:widget 单行 ASCII 微图（`▁▂▃▅▇` 系列或等宽 bar）
- 验收:mock 序列注入 usage → 渲染输出含可辨 dip;null cacheRead turn
  显示占位符（非零、非崩溃）;纯函数测试

**S4 · trust-protocol 指示**（flag-on 时）
- 展示:stale-view hint 触发时在该 turn 产生一条可见标记,包含
  path 和 birth→current hash 对
- 数据源:`staleViewHints()` 返回值（context hook 内已计算,无需
  重算——把 hint 列表缓存到 module-level holder 供 widget 读取）
- 门控:`ECODE_TRUST_PROTOCOL` off 时不渲染、不注册、不占空间
- 验收:flag-on mock 有 hint → 标记可见;flag-off → 无渲染;
  flag-on 但无 stale → 无渲染;纯函数测试

**S5 · `/compact-dash` 汇总视图**
- 展示:以上四件的会话级汇总（单命令一屏）:
  - gate 当前状态（S1 数据）
  - 累计触发次数 + 总 saved tokens（S2 数据）
  - CH 轨迹全图（S3 数据,全 session 不截断）
  - trust-protocol hint 累计触发数（S4 数据,flag-off 时该行不出现）
- 渲染:`registerCommand("compact-dash")`,输出经 `sendMessage`
  customType 渲染（同 compact-status 模式）
- 验收:mock session 跑完 → 命令输出包含四部分;数字与分部件一致;
  纯函数测试

### 每片通用验收

- 渲染逻辑纯函数化（`(state) => string[]`,无 side effect）+ vitest 单测
- extension 全量回归绿（73+ tests）
- `pi/` 零 diff（`git diff pi/` 为空）
- flag-off / flag-on 两态渲染正确（S4 在 flag-off 时不可见）

### 总验收（产品级）

**一次真实 session 的截图序列能不看文档讲清「压缩发生了什么、值不值」。**
具体:从 gate waiting → 越阈触发 → CH dip → CH 恢复 → `/compact-dash`
汇总,5 张截图构成一个自解释叙事。这直接服务发布种子的质量叙事——
将来 README 或推文串里的那几张图,就从这条验收里出。

### 禁区

- 不碰 pi core（案底重申——L3 违规教训）
- 不改 compaction-core 投影算法、不改 trust-protocol 逻辑——纯展示层
- 数字口径沿用 F-A 裁定:compactable 与 context 总量分别标注,
  永不混算

> **状态（2026-07-05,Fable 验收）**:S1-S5 单元级验收通过（100/100,
> `pi/` 零 diff;S2 经监工压缩事件后独立 audit,补齐纯函数测试缺口）。
> **spec 修正**:触发标记渲染以实现为准——`registerEntryRenderer`
> （appendEntry 路径),原文 `registerMessageRenderer` 作废
> （sendMessage 的 `deliverAs:"steer"` 有中流转向风险,DF1 案底）。
> 剩余:总验收（真实 session 五张截图叙事),建议 **Codex** 执行——
> 直读 terminal 窗口,免 Claude Code 的手动 loop。

## G3-AR · 实验产物留存 + session review 缓存（阻塞 R2-preflight;Codex 可执行,packet 自含）

背景:round 1 质量复核失败——`run.ts` 在写 JSONL 后 `rmSync(tempDir)`,
12 个 workspace 全灭,completion/quality 永久不可审(E1-C static 0/5
的发现全靠 acceptance 代理)。两件合一,同一数据面。
2026-07-06 裁定:Codex 的补账与 gate-release 预算裁定通过;本 packet
是 R2-preflight 第一前置,先发 Codex。

**任务**:
1. `run.ts` 产物留存:run 结束、清理 tempDir **之前**,导出到
   `experiments/results/<run>/artifact/`——allowed outputs 文件、
   `git diff --stat` + `git diff`(相对快照)、pending command checks
   的实际执行输出(R1 类的 pnpm test/typecheck 结果另存 log)。
   体积失控风险:diff 超过 1MB 截断并标注。
2. compare.ts 陈旧标头修复(fix-forward 已裁):按 meta.provider
   打标,mock 才写 SYNTHETIC。
3. **DF-REC 落地**(masterplan 第六节既有 packet,并入本 goal):
   `/session-export` 或 post-session 脚本,打包 session JSONL 路径 +
   ambient 行 + `/compact-dash` 终态 + 触发标记列表 →
   `results/reviews/<session-id>.md`。F-A 双口径分别标注。
**验收**:重放一个 R1 run,artifact 目录齐全且 diff 可读;compare
重新生成后标头正确;一次真实 session 后 review 文件可读。
**禁区**:不碰 pi;不改 compaction/trust 逻辑;不动已有 JSONL schema
(只增不改)。

## V3-WS · 工作语义 summarize 策略（Opus 执行;flag 门控,评估等 R2）

背景:round 1 的 turn 膨胀 + E1-C 任务未完成(投影 26 次,产物缺席),
指向投影后**工作语义丢失**——模型忘了自己做到哪。社区证据
(Factory:structured/anchored 3.70 vs 原生 3.44/3.35)确认结构化
优于散文摘要;我们做**确定性版 anchored summary**,不引入 LLM 调用。

**设计**:
1. **工作语义锚点块**:extension 维护一个 deterministic 分节状态块
   (files touched + hash / edits done + diffstat / tests run + 结果 /
   pending task 由 packet acceptance 派生),全部来自 tool 事件,
   零 LLM。投影发生时,锚点块注入 volatile 尾区(与 stale-view hint
   同通道,同前缀纪律:send-time only、byte-stable 区外)。
2. per-tool 摘要结构升级:read summary 加导出符号清单(确定性解析,
   仅 .ts 起步);edit summary 已有 hash+diffstat(V2-TP)。
3. flag:`ECODE_SEMANTIC_ANCHOR`,默认 off——**R2-core 的 C 臂冻结
   在现行 v1,本策略作为 C'' 臂在 core 之后追加评估**(与 Codex
   预算的 gate-release 结构一致)。建设可与 G3-AR 并行,但数字必须
   排队,不得混入 R2-core。
**假设(可证伪)**:锚点块显著降低 turn 膨胀(压缩臂 turns 逼近 A 臂),
E1 类任务 static acceptance 不再缺席。
**验收**:单测(锚点块纯函数、分节格式、尾区注入 ≤1/turn);flag-off
字节等价回归;mock 场景重放。
**禁区**:不碰 pi;锚点内容仅可机械验证事实(信任协议同款纪律——
不写「进展顺利」类评价,只写「edited X, hash Y→Z, tests 7/7」)。

> **状态(2026-07-06,Fable 验收)**:G3-AR 完成(artifact 导出 +
> compare 标头修复 + export-review,46 测试,smoke 实证);V3-WS 完成
> (分支 `v3-ws-semantic-anchor`,4 commits,137 测试,绊线干净,
> 自审抓获 failed-edit/pending 正确性 bug——RED→GREEN 修复在案)。
> **裁定**:① V3-WS 留分支不并 main,R2-core 全程以 main(v1)跑
> C 臂,core 完成后并入再跑 C'' 追加——基线论证保持无懈可击;
> ② `ECODE_ANCHOR_ACCEPTANCE` 的 harness 侧接线归 experiments
> (run.ts 从 packet 的 file-exists 行提取路径填 env,仅 C'' 臂),
> 作为 R2-preflight 预备项交 Codex;③ read summary 符号清单
> (V3-WS 设计 2)确认为独立后续 packet,不并本轮;④ R2-preflight
> 另两项预备:B-fixed(B 臂 session 配置可比阈值)与 D1 触发修复
> (低阈值 8k 或扩容,执行者按 verdict 二选一,触发即过门)。

task packets：refactor / exploration / **direct-transformation（负区间必跑臂）**
三类固定编号；Mimo 为被试跑 token 轴；DeepSeek API 跑 cache 轴对账
（预期 transition 曲线 vs 实测 hit/miss）。判定与止损按 roadmap 第四节：
C 对 A <10% 且 re-read 率不降 → 归档阴性。

---

> **程序收束（2026-07-08）**：G4 起的批次隶属「context 剪裁系统学」
> 纲领——frontier harness/provider 侧机制复刻为 thin-harness
> extensions，三列账本统一测量。机制全录 × 可行性矩阵、统一管线、
> 批次规划（B2=G5 thinking clearing，前置核证先行）见
> `docs/program-context-pruning-2026-07-08.md`。

## G4 · Frontier Pruning Replica — TRC（2026-07-08 立项）

**判权已裁**（2026-07-08）：交付形态 = 设计包 + packets；首批机制 =
tool result clearing 单项；架构 = `packages/context-pruning/`（纯函数）
+ `extensions/frontier-pruning/`（pi adapter）。

设计：`docs/arch-frontier-pruning-design-2026-07-08.md`（含官方规格
核证、Rulings R1-R10、分歧表 D1-D8；D4/D5 已于同日二轮取证后裁定，
LangChain 复刻先例对照与 PROBE-TRC 实证探针见其 §8.1/§8.2）。packets：
`docs/g4-frontier-pruning-packets-2026-07-08.md`（G4a 核心包 → G4b
adapter+冒烟 → G4c 遥测+指纹接线）。

要点：门控变量与被控动作解耦（发现 1 防复发，显式取代 G1b 修正 #2
的估计器禁令）；`clear_at_least` 为头号实验变量；与 C-v1 臂正交、
不碰 SWEEP-R2 冻结；EXP-TRC-* 真 run 排在 SWEEP-R2 与 E1×C'' 之后，
逐项归人裁。完成定义 = G4a-c 落版且 `pi/` 零 diff。

> **状态（2026-07-08，Fable 验收）：G4 完成**。G4a（23 用例 + 独立
> 冒烟 7/7）、G4b+G4b-R（31 用例 + 独立冒烟 8/8 + 真 loop JSONL
> 双向校验）、G4c（74+31 用例 + Fable 沙箱独立端到端 T 臂 fixture
> run）均落版验收；`pi/` 全程零 diff。三个执行 packet 共产出 15 个
> 存疑点，逐条裁定入设计文档（D9-D11、KNOWN-ISSUE G4a-5、EXP-TRC-3
> 前置债）。按 2026-07-08 判权裁定，对外口径切换条件已达成。

---

### 给分发者的备注

- G0 与 G1a 可同时开两个 agent；G1b 必须等两者 merge。
- 每个 agent 冷启动只喂：本 packet + 列名文件 + G0 的 survey（G1b/G1c）。
  不给整个 taucode docs——那是污染源也是 token 浪费（见 note-subagent-economy）。
- 「15-17%」数字禁止出现在任何代码注释或 README 里，干净 run 之前它不存在。

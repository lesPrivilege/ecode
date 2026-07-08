# ARCH-FPR-DESIGN — Frontier Pruning Replica：tool result clearing（TRC）

2026-07-08，Fable cowork pass。上游依据：frontier context 修剪机制调研
（Claude/Codex 十四机制清单，官方文档级引用，见
`note-landscape-compaction.md` 2026-07-08 增补节）+ 本 repo 三列账本框架
（cache 价格 / 可复现性 / 失效指纹）。

判权记录（操作者已裁，2026-07-08）：

1. 交付形态 = 设计包 + Goal packets（G4 系列），实现留分发轮；
2. 第一批机制 = **tool result clearing** 单项（thinking clearing /
   cache-aware pinning / 初始上下文重注入留后续批次）；
3. 架构 = 新包 `packages/context-pruning/`（纯函数、零 harness 依赖）
   + `extensions/frontier-pruning/`（薄 pi adapter）。

## 0. 范围与命题

复刻对象：Anthropic `clear_tool_uses_20250919`（server-side context
editing）的**客户端确定性复刻**，运行于 pi 等薄 harness / 任意
OpenAI-compatible provider（首先 DeepSeek）之上。

命题：frontier 的修剪菜单已公开列出 WHAT；本 repo 的差异化是给每个
WHAT 补 price list、reproducibility class、failure fingerprint。TRC 是
第一个「非本 repo 原生」机制进入同一台架——与 seam-A 确定性投影（C 臂）
同台对照后，三列账本第一次覆盖两种异质机制。

TRC 与 C 的本质差异（实验价值所在）：C 做**结构化摘要**（保 path、
行数、head/tail），TRC 做**整结果清除**（placeholder 留痕，path 仅在
默认配置下经配对 toolCall args 存活）。两者对 (a) 信息缺口指纹的
预测方向不同——这是可证伪的。

## 1. 参考规格（2026-07-08 对 platform.claude.com 核证）

来源：`platform.claude.com/docs/en/build-with-claude/context-editing`。

| 参数 | 默认 | 语义 |
| --- | --- | --- |
| `trigger` | 100,000 input tokens | 阈上激活；可用 `input_tokens` 或 `tool_uses` 计 |
| `keep` | 3 tool uses | 清除后保留最近 N 个 tool use/result **对**；最老先清、时间顺序 |
| `clear_at_least` | None | 单次激活至少清出 X tokens，否则**整个策略不应用**——官方明文「helps determine if context clearing is worth breaking your prompt cache」 |
| `exclude_tools` | None | 列名工具的 use+result 永不清 |
| `clear_tool_inputs` | `false` | 默认只清 result、保留 toolCall 参数可见；true 时连参数一起清。**SDK 增量**（docs 页未载）：官方 TS SDK 类型为 `boolean \| Array<string>`——可按工具名列表选择性清 inputs |

行为要点：

- 清除的 result 被 **placeholder 文本**替换（模型知道被清过）；
- server-side、到模型前应用；**客户端历史保持完整未改**——与 seam-A
  的 send-time 投影同构，这是复刻可行的结构前提；
- 回报面：`context_management.applied_edits` 含
  `{cleared_tool_uses, cleared_input_tokens}`；token counting 端点可
  预览 `original_input_tokens → input_tokens`；
- cache 条款（官方明文）：清除发生时 invalidate cached prefix，
  `clear_at_least` 就是把「值不值得破 cache」纳入配置的经济门。

无状态性推论：server 每请求重算清除集（客户端送全量历史），故该机制
在数学上是 `(messages, config) → messages'` 的纯函数——复刻为确定性
纯函数不是近似，是同构。

## 2. Rulings

R1 — **复刻保真契约**。参数面、默认值、清除顺序、keep 对语义、
clear_at_least 的 all-or-nothing 语义与官方规格 1:1。规格未定义处
（placeholder 确切文本、error result 是否可清、token 计法）一律向
byte-stable 与确定性倾斜，并逐条登入 §8 分歧表。复刻不是模仿产品，
是把机制钉成可对照的实验对象——分歧必须显式，不许静默。

R2 — **运行位置 = send-time 投影，永不落盘**。与 seam-A 同纪律：
context hook 只改发出视图，session JSONL 原始历史逐字节不动（落盘
校验进验收）。拒绝 ingest 时破坏——溯源不可逆是三列账本里最贵的负债。

R3 — **门控变量与被控动作解耦（发现 1 的直接消化）**。TRC 的
trigger 读数由**注入的纯估计器**在原始 transcript 上计算，禁止混入
provider usage 反馈。`note-projection-turn-variables-2026-07-08.md`
发现 1 已证明 pi `estimateContextTokens` 的 usage 反馈会使门控被投影
动作自污染（周期 2 振荡、全 corpus 普遍）。**本条显式取代 G1b 修正
#2 的「禁自造 char 估算」禁令**（该禁令防的是单位错配；自污染是更贵
的病）：TRC 门控用 chars/4 之类的单调字节度量，单位只与自身阈值比较、
自洽即可，并在遥测中标注单位。此分歧对官方（server 用真 tokenizer
计数）登分歧表。

R4 — **`clear_at_least` 是本机制的头号实验变量**。它是 frontier 菜单
里唯一显式定价 cache 断裂的参数。复刻语义：可清集合的估计 token 量
< clearAtLeast → **恒等返回（原数组引用）**，cache 完整保留。价格
形状预判（待测）：clear_at_least 只在激活边缘造成一次台阶；激活后
keep 窗口每 turn 老化一对 → 近尾断点节奏与 C 臂 keepRecent 年龄边界
税同形。两机制边界税同形而摘要形态不同——这让 (a) 指纹对照干净。

R5 — **确定性与幂等**。同 `(messages, config)` 同输出；对已清除
transcript 再应用为恒等；transcript 单调增长时清除集单调不减且已清
位置的 placeholder 字节恒定（投影谱系 byte-stable，同 seam-A 性质）。
placeholder 为**固定常量字符串**，不嵌 token 数、不嵌时间戳——被清
量入报告不入 payload。

R6 — **与 C 臂正交，round 1 不组合**。TRC 走独立 extension 与独立
flag；首轮实验臂彼此隔离（A / C-v1 / TRC），组合臂（C+TRC）是
round-2 命题。SWEEP-R2 的 v1 冻结不受影响：TRC 是新臂，不碰 C-v1
任何路径。

R7 — **失效指纹先接线再跑**。TRC 清整结果，预测指纹是 (a) 信息缺口
（对被清 path 的重读）；对照假设：同等 token 节省下 TRC 的
(a)-gap 重读多于 C（C 的摘要保 path+规模事实）。`clear_tool_inputs=true`
是更强对照：连 path 都不存活，预测 (a) 恶化一档。接线要求：被清
toolCallId→path 映射落 sidecar ledger，使 `cleared_path_re_reads`
可计，直接喂 FP-1 (a) 检测器。检测器结果在参数定档前不得入结论
（FP-1 判权纪律原样适用）。

R8 — **可移植边界 = 包边界**。`packages/context-pruning/` 复用
compaction-core 的 `Message`/`ToolCall` 数据形状（import type，零逻辑
依赖），注入点：token 估计器、placeholder 常量（可选覆盖）、tool-name
匹配。零 pi 依赖、零 DeepSeek 依赖——「能用在别的薄 harness」由包的
依赖图保证，不由承诺保证。

R9 — **adapter 复用为受控债**。`Message ↔ AgentMessage` 适配器已在
`extensions/deterministic-compaction/src/adapter.ts`（G1b，专项测试
在册）。round 1 新 extension 以相对路径 import 复用，不复制不重写；
抽出为共享包是登记在案的债，退役触发 = 第三个消费者出现。

R10 — **Design now, run later**（沿 arch-c3 R1）。本设计不烧 run。
TRC 真 run 排在 SWEEP-R2 与 E1×C'' 既定队列之后；届时 n、任务集、
预算逐项归人裁。

## 3. 包规格 — `packages/context-pruning/`

```
src/
  types.ts            // re-export compaction-core Message 形状 + TRC 专属类型
  clear-tool-uses.ts  // 机制本体（纯函数）
  index.ts
test/
  clear-tool-uses.test.ts   // golden fixtures
```

公开 API（形状，签名细节由实现 packet 定稿）：

```ts
interface ClearToolUsesConfig {
  trigger: { type: "input_tokens" | "tool_uses"; value: number }; // 默认 {input_tokens, 100000}
  keep: { type: "tool_uses"; value: number };                     // 默认 {tool_uses, 3}
  clearAtLeast?: { type: "input_tokens"; value: number };         // 默认无
  excludeTools?: string[];                                        // 默认无
  clearToolInputs?: boolean | string[];                           // 默认 false；string[] 按 SDK 类型（D7）
  preserveErrorResults?: boolean;  // 默认 false（规格保真）；true 为本地纪律扩展，属分歧
}

interface ClearToolUsesDeps {
  estimateTokens: (messages: Message[]) => number; // 注入；纯；原始 transcript 单调度量
  placeholder?: string;                            // 缺省用包内常量
}

interface ClearToolUsesOutcome {
  messages: Message[];        // 恒等时 === 原引用
  applied: boolean;
  report: {
    type: "clear_tool_uses_replica";
    clearedToolUses: number;
    clearedInputTokens: number;     // 估计器单位，字段名带 Est 语义、报告中标注
    originalInputTokens: number;    // 镜像 count_tokens 预览面
    inputTokens: number;
    gateReading: number;            // 驱动 trigger 的读数（审计用）
  };
}
```

语义细则：

- 「对」= toolCall（assistant 消息内）与其 result 消息按 `toolCallId`
  配对；孤儿 result / 未回果 call 不清、不入 report（**G4a 验收修正**：
  原稿「计入 report 注记」与 report 形状镜像官方面自相矛盾——官方
  applied_edits 亦无孤儿字段，保真优先；孤儿计数移交 G4c adapter 级
  遥测）；
- trigger 边界：官方措辞「exceeds」→ 严格大于才激活（恰等于阈值 =
  恒等），fixture 钉死；
- 清除顺序：按配对 toolCall 出现顺序最老先清，直到只剩最近 keep 对
  （excludeTools 命中者跳过且**不占 keep 名额**——D5 已裁，见 §8）；
- `clearToolInputs=true`：toolCall.arguments 替换为空对象 + placeholder
  注记，result 同常清除；`string[]` 形态 = 仅列名工具的 inputs 被清
  （D7，SDK 类型面）；
- 恒等路径三处：阈下 / 可清集为空 / clearAtLeast 不满足——全部返回
  原数组引用（reference equality 进测试）。

## 4. pi adapter — `extensions/frontier-pruning/`

- `context` hook（缝 A）注册，行为 = adapter 转换 → `clearToolUses`
  → 逆转换；恒等时原引用透传；
- flags（env，与 deterministic-compaction 同风格）：
  `ECODE_TRC=1`（总开关，默认 OFF）、`ECODE_TRC_TRIGGER_TOKENS`、
  `ECODE_TRC_KEEP`、`ECODE_TRC_CLEAR_AT_LEAST`、
  `ECODE_TRC_EXCLUDE_TOOLS`（逗号分隔）、`ECODE_TRC_CLEAR_TOOL_INPUTS`、
  `ECODE_TRC_PRESERVE_ERRORS`；
- 估计器注入：包外提供 chars/4 原始 transcript 度量（R3）；**不接**
  pi `estimateContextTokens`；度量域 = content + thinking + toolCalls
  序列化（G4b 验收澄清：thinking 是生成内容非 usage 场，纳入不违 R3；
  永不读 meta/usage 类字段）；
- 遥测：run JSONL turn 行增量字段 `trc: {applied, clearedToolUses,
  clearedInputTokensEst, gateReading}`（schema 只增不改）；被清
  toolCallId→path 映射追加 sidecar ledger（R7）；
- 对 pi 上游 diff = 0（纯 extension，围栏纪律不变）。

## 5. 测试计划（golden fixtures，gates.ts 纪律）

核心包：trigger 两种计法的边界（阈下恒等引用 / 恰等阈值恒等（严格
大于才激活）/ 阈上）；keep
窗口滑动（老化一对 → 恰好一对新清，其余 placeholder 字节不变）；
时间顺序（乱序 id 不乱清序）；excludeTools（含全排除 → 可清集空 →
恒等）；clearAtLeast 不满足 → 恒等引用；满足 → 一次清足（all-or-nothing，
D8 反例 fixture：清一半够不着阈 → 全不清）；
clearToolInputs 三态（false/true/string[]）；error result 两 flag 态；
幂等（f(f(x))=f(x)）；
单调 transcript 下投影谱系 byte-stable（fixture 锚定，同 seam-A
恒等路径纪律）；
孤儿配对；report 数字与 fixture 手算一致。

adapter/extension：AgentMessage 往返无损（复用 G1b adapter 测试面）；
hook 阈下引用透传；mock provider 冒烟（复用 G1b scripted mock 模式）
穿 loop 验证清除生效且 session JSONL 未被改写（落盘校验）；flags
解析与默认值。

## 6. 实验 manifest（design now, run later — R10）

- **EXP-TRC-1（对照）**：A / C-v1 / TRC-default 三臂，R2 同任务集
  子集；主读数：三列账本——token 节省、cache transition 形状
  （断点位置与恢复节奏）、(a)-gap `cleared_path_re_reads`；
  假设 H1：同等节省下 TRC 的 (a) 重读 > C；H2：TRC 边界税节奏与
  C 同形（R4 预判）。
- **EXP-TRC-2（价格扫描）**：clearAtLeast ∈ {0, 5k, 20k} 单变量，
  读数 = 激活频次 × 单次断裂深度的权衡曲线——frontier 菜单上第一次
  有人给这个参数画实测曲线。
- **EXP-TRC-3（强对照，可选）**：`clear_tool_inputs=true`，验证
  path 存活性对 (a) 恢复的贡献。**前置债（G4c 验收登记）**：现遥测
  只对 path 存活的清除对计 `cleared_path_re_reads`，path 不存活的
  清除对无 JSONL 可见字段（G4c 存疑点 #4 裁定：不混计是对的，但
  TRC-3 的读数需要死径清除的独立计数）——跑 TRC-3 前须补
  `trc.clearedPathsDead` 类字段 + toolCallId 级审计 ledger（存疑点
  #5 的债同此退役触发）。
- n、预算、排期：判权，不在此定。

## 7. 遥测与指纹接线

FP-1 (a) 检测器现消费 `compacted_path_re_reads`；TRC 提供同构的
`cleared_path_re_reads`。分类学扩展：机制字段 `meta.mechanism` 增
`"trc"` 取值，A 臂空真标注逻辑原样适用。(b)/(c)/(d) 对 TRC 的适用性
预判：TRC 无摘要环节 → (b) 结构性不适用（placeholder 不承载事实，
无「摘要缺陷」可言，检测器应报 signal-absent 而非 0）——这本身是
三列账本的一格：**整清机制用 (a) 风险换掉 (b) 风险**。

## 8. 分歧表（replica divergence ledger）

| # | 项 | 官方 | 复刻 | 状态与理由 |
| --- | --- | --- | --- | --- |
| D1 | 运行位置 | server-side | 客户端 send-time 投影 | 结构性。DeepSeek 无此 API；同构（客户端历史都不改） |
| D2 | trigger 计数 | 真 tokenizer input_tokens | 注入单调估计器（chars/4） | 结构性。R3 解耦纪律；客户端无免费 tokenizer 真值；单位自洽即可 |
| D3 | placeholder 文本 | 未公开（server 注入，客户端结构上不可观测） | 包内固定常量 | 结构性不可核证；byte-stable 优先 |
| D4 | error result 可清性 | 规格未提 | **已裁（2026-07-08）**：默认可清（保真优先）；`preserveErrorResults` 为显式本地扩展 | docs/SDK 均沉默；LangChain 复刻同样不区分 error（弱佐证）；PROBE-TRC P1 可实证升级 |
| D5 | excludeTools 与 keep 名额 | 规格未明 | **已裁（2026-07-08）**：排除者不占 keep 名额（非排除类保底恰 keep 对） | LangChain 复刻取反向（keep 先切片、排除后过滤）——但其在**有文档**的 clear_at_least 语义上已被证走偏（见 §8.1），其无文档处选择只作弱证据。取保底语义：留存下界确定、fixture 可锚。PROBE-TRC P2 可实证升级 |
| D6 | cleared_input_tokens 单位 | 真 token | 估计器单位 | 结构性。随 D2；报告显式标注单位 |
| D7 | clear_tool_inputs 类型 | docs 页 `boolean`；SDK 类型 `boolean \| Array<string>` | 支持两态（SDK 面为准） | **已裁（2026-07-08）**：官方 SDK 类型面 > docs 页散文 |
| D8 | clear_at_least 语义 | 明文 all-or-nothing 适用门（「can't clear at least → not applied」） | 严格照官方 | **已裁（2026-07-08）**：非分歧项，列此专防踩 LangChain 的误读（见 §8.1） |
| D9 | `tool_uses` trigger 计数口径 | 规格未明 | 全部 toolCall 出现次数（含孤儿 call，不含孤儿 result） | **已裁（G4a 验收，2026-07-08）**：与配对/清除逻辑解耦，口径单调 |
| D10 | error 信号源 | server 可见 `is_error` 字段 | `Message` 形状无一等 isError → 约定桥 `meta[ERROR_RESULT_META_KEY]===true` | **已裁（G4a 验收）**：adapter 负责从 harness 的 isError 填桥（G4b 任务项） |
| D11 | preserveErrorResults × clearToolInputs 交叉 | 本地扩展，官方无此项 | 整对豁免（result 与 inputs 都不清） | **已裁（G4a 验收）**：保留错误却抹掉致错参数不自洽；kitchen-sink fixture 锁定 |

### 8.1 同类复刻先例对照 — LangChain `ClearToolUsesEdit`（证据轮，2026-07-08）

来源：`langchain/agents/middleware/context_editing.py`（langchain_v1，
自述「Mirrors Anthropic's context editing capabilities」，模型无关
客户端中间件——与本设计同一结构位：deepcopy 后改 send 视图，不落盘）。
逐项对照：

| 项 | LangChain 行为 | 本复刻 | 评注 |
| --- | --- | --- | --- |
| clear_at_least | **止损预算**：逐对清、清够即 break；不满足时照清不回滚 | all-or-nothing 适用门 | LangChain 与官方明文相悖——公开生态里「复刻漂移」的现成样本，恰证分歧表纪律必要 |
| keep × exclude | keep 先对全部 tool 结果切片，排除在片内过滤（排除者占名额） | 排除者不占名额 | 两复刻分叉点 = D5；官方真值待 PROBE-TRC |
| error result | 不区分，同常清 | 默认同（D4） | 一致 |
| trigger 边界 | `tokens <= trigger` 恒等（严格大于激活） | 同 | 一致，与官方「exceeds」相符 |
| placeholder | `"[cleared]"` 常量 | 包内常量 | 结构一致；文本自定 |
| 门控读数 | `count_tokens_approximately` 或模型计数（可选） | 注入单调估计器 | 同构；LangChain 未处理 usage 反馈问题（其架构无此耦合面） |

### 8.2 PROBE-TRC — 官方行为实证探针（可选，判权门控）

原理：Anthropic **token counting 端点**支持 `context_management` 且
无采样（不烧推理预算），响应含 `original_input_tokens → input_tokens`。
用尺寸已知的合成 transcript 构造判别 fixture，读 token 差即可二值判定：

- **P1（D4）**：可清集合仅含 error result 的 transcript——若
  `input_tokens < original` → error 可清；
- **P2（D5）**：最近 3 对全为 excluded 工具 + 更老的非排除对（各对
  尺寸互异）——两种 keep 语义产出可区分的 token 差；
- **P3（D8）**：clearAtLeast > 可清总量——期望恒等（验证 all-or-nothing，
  同时终裁与 LangChain 的分叉）。

前置：Anthropic API key（本 repo 现绑 DeepSeek，key 与执行时点归人裁）。
探针结果落 report 后，D4/D5 状态从「已裁（推定）」升「已证」，若反证
则改实现并在分歧表记录翻案。

## 9. 未决与退役触发

**KNOWN-ISSUE G4a-5（工程危害，已遏制未根治）**：`tsc -p
tsconfig.build.json` 在 rootDir 收紧时不仅报 TS6059，还会把编译产物
按 `outDir + relative(rootDir, input)` **实际写进
`packages/compaction-core/src/`**（`../../` 越过 dist 逃逸）——G4a
执行中实测发生并已清除（均为 untracked 新文件，未覆盖已有内容）。
现遏制：`npm run build` 已换成 exit-1 护栏（原命令存
`build:unsafe-disabled`）；typecheck 的 tsconfig 已去 rootDir，
`npm test` / `npm run typecheck` 为本包验收口径且干净。根治需仓库层
方案（TS project references，或 compaction-core 以可解析包形态
link/发布），登记为债；退役触发 = 本包需要真实 dist 产物时（如 npm
发布前置）。在此之前禁跑 build。

- 后续批次（本设计不含，判权后另开）：thinking clearing（DeepSeek
  reasoner 场景）、cache-aware pinning（依赖 cache 位置估计器，
  须先解决发现 2 的单位错配）、初始上下文重注入；
- adapter 抽包：第三消费者出现时执行（R9）；
- 若 DeepSeek 上线 server-side clearing/compaction API：TRC 复刻降级
  为对照基线，landscape R6（arch-c3）复活条款同款适用。

分发链：见 `docs/g4-frontier-pruning-packets-2026-07-08.md`。

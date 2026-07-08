# Context 剪裁系统学：frontier 机制的确定性复刻与三列账本

> Working paper 中文稿，2026-07-08。主稿为 EN：
> `paper-pruning-replica-2026-07-08.md`（repo 惯例 EN 先行、ZH 随译；
> 本文成稿顺序例外——ZH 先落、EN 补正——自此以 EN 为准，两稿修订
> 须同步）。
> 状态：方法与工程事实已全部落版可核验（G4 系列，`pi/` 零 diff）；
> 对照测量（EXP-TRC-*）已预注册未执行——本文不含任何 TRC 成本/质量
> 数字，凡涉测量处均为预注册假设并如此标注。
> 姊妹篇：《外化天花板与跨层 cache 契约》（paper-context-economy，
> 已有受控数据）；本文是其方法论的第二次实例化——对象从自研机制
> 换成 frontier 机制。

## 摘要

Coding agent 生态已经积累了一整层「context 剪裁」机制：Anthropic 的
server-side context editing 与 compaction、OpenAI/Codex 的 compact
端点与本地压缩、Claude Code 的多层 pre-request pipeline。公开材料
把 WHAT 列得很全，但三个对选型真正致命的维度系统性缺席：**cache
价格**（机制触发时对 prefix cache 的破坏形状）、**可复现性**（同输入
是否同输出、事后能否审计）、**失效指纹**（机制引发的行为失效属于
哪一类、能否从遥测机械判定）。本文提出并实例化一条方法：把 frontier
机制**确定性复刻**为薄 harness 的 extensions，使其在无该能力的
provider（如 DeepSeek）上可运行、可插拔、可与自研机制同台，然后在
同一台架上按三列账本统一测量。第一个复刻对象是 Anthropic
`clear_tool_uses_20250919`。复刻过程本身产出了一组方法论工件——
保真契约、分歧表、证据等级、官方行为探针——以及一个规格考古发现：
LangChain 的同名客户端实现与官方已文档化语义相悖。

## 1. 问题：分类学止步于 WHAT

对 Claude / Codex 公开材料与源码的专项调研（14 项机制，官方文档级
引用）显示，「context 修剪」不是一种东西而是层级菜单：LLM 全量摘要
替换、远端 opaque compact window、send-time 投影、tool result
clearing、thinking clearing、subagent 隔离、初始上下文重注入、
provider/model 分叉 compact。真正的形态差异不在功能描述，在：
**是否改历史、是否只改 send 视图、是否破 cache、是否由 LLM 生成
摘要、是否可审计**。

行业已开始把其中一列写进参数面：Anthropic `clear_at_least` 官方明文
「helps determine if context clearing is worth breaking your prompt
cache」——cache 断裂第一次成为机制的显式配置变量。但没有任何公开
工作给这些参数画实测曲线。这就是本程序的空档。

## 2. 方法：复刻管线与分歧表

### 2.1 结构前提：send-time 同构

Anthropic context editing 是 server-side 的，但其契约有一个关键性质：
**客户端历史保持完整未改**，编辑只发生在 prompt 到达模型前。这与
薄 harness 的 send-time 投影（context hook 只改发出视图、session
历史逐字节落盘）在结构上同构。且 server 每请求对全量历史重算清除集
——机制在数学上就是 `(messages, config) → messages'` 的纯函数。
**复刻不是近似，是同构**：客户端确定性纯函数可以逐语义复刻它。

### 2.2 管线（六步，已走通全程）

```
规格核证（官方 docs + SDK 类型面 + 先例复刻对照）
→ 分歧表 + 证据等级
→ 纯函数包（零 harness 依赖，golden fixtures TDD）
→ 薄 adapter（harness 零 diff，真 loop 冒烟 + 落盘校验）
→ 遥测 + 指纹接线（schema 只增不改）
→ 三列账本测量（预注册，run 判权独立）
```

### 2.3 保真契约与分歧表

复刻纪律：参数面、默认值、清除顺序与官方规格 1:1；规格未定义处
一律向 byte-stable 与确定性倾斜，且**逐条登记分歧表**（本例 D1-D11），
每条标注状态：结构性分歧（如客户端无真 tokenizer）、已裁（推定）
（规格沉默处的钉死选择）、已证（有官方行为实证）。「已裁（推定）→
已证」的升级路径是**零采样成本探针**：Anthropic token counting 端点
支持 context_management 且不烧推理预算，用尺寸已知的合成 transcript
读 `original_input_tokens → input_tokens` 差值即可二值判定规格沉默处
的真实行为（PROBE-TRC P1-P3，已设计待执行）。

### 2.4 证据等级为什么必要：复刻漂移的野外样本

取证轮发现，LangChain 的 `ClearToolUsesEdit`（自述 "Mirrors
Anthropic's context editing capabilities"）在**有文档**的语义上就已
走偏：`clear_at_least` 被实现为「清够即停」的止损预算，官方明文是
all-or-nothing 适用门（清不够阈值则整个策略不应用）。一个直接推论：
先例复刻在规格沉默处的选择只能作弱证据——它在有明文处尚且漂移。
公开生态的复刻漂移不是个别 bug，是「无分歧表纪律」的系统性后果，
恰好构成本方法的反面对照。

顺带的规格增量：官方 TS SDK 类型显示 `clear_tool_inputs` 实为
`boolean | Array<string>`（docs 页只写 boolean）——SDK 类型面严于
散文文档，核证必须两面都做。

## 3. 案例：clear_tool_uses 的复刻（G4 系列，已落版）

### 3.1 实现事实

- `@ecode/context-pruning`：纯函数包，零 harness / provider 依赖，
  23 golden-fixture 用例。三处恒等路径（阈下 / 可清集空 /
  clearAtLeast 不满足）全部返回**原数组引用**——prefix cache 契约
  由构造保证；幂等与单调 transcript byte-stable 有 fixture 锚定。
- `extensions/frontier-pruning`：薄 pi adapter，31 用例，含真
  agent loop 冒烟——真工具执行、send payload 含 placeholder 而
  磁盘 session JSONL 逐字节保持原文（双向断言：原文在档 +
  placeholder 零出现）。上游 fork 全程零 diff。
- 遥测：T 臂（机制单独在位）产出的 run JSONL 携带
  `trc:{applied, clearedToolUses, clearedInputTokensEst, gateReading}`
  与 `cleared_path_re_reads`（与自研投影的 `compacted_path_re_reads`
  并列同构、不合并语义），失效指纹检测器直接消费。

### 3.2 两条工程不变量（可迁移的教训）

**门控变量与被控动作解耦。** 早前在自研投影上实测到门控自污染：
门控读数混入 provider usage 反馈后，投影动作压低下一轮读数，形成
投影/恒等的周期 2 振荡（全 corpus 普遍，8k 低阈 run 反证机制）。
复刻实现因此规定：trigger 读数由注入的单调估计器在原始 transcript
上计算，永不读 usage 类字段，且有负向测试（篡改 usage 字段、断言
门控读数不动）。这与官方 server-side 用真 tokenizer 计数构成一条
结构性分歧（D2），如实入表：客户端无免费 tokenizer 真值，门控单位
只需自洽，单调性比准确性重要。

**恒等契约作为跨层承重结构。** adapter 的写回检测不用任何标记，
只用核心包的恒等契约：未动消息原引用返回，故 `projected[i] !==
original[i]` 即「此条被清过」的完备判据。该契约随即被显式 pin 进
核心包测试面——当一个实现性质被下游承重，它就从实现细节升格为
契约，必须有守卫测试。

### 3.3 与自研机制的形态对照（可证伪的预注册假设）

自研 seam-A 投影做**结构化摘要**（保 path、行数、head/tail）；TRC
做**整结果清除**（placeholder 留痕；默认配置下 path 经配对 toolCall
args 存活，`clear_tool_inputs=true` 时连 path 都消失）。由此预注册：

- **H1**：同等 token 节省下，TRC 的 (a) 信息缺口重读（对被清 path
  的重读）多于结构化摘要——摘要保留的规模事实降低重读需求；
- **H2**：TRC 的近尾断点节奏与自研投影的年龄边界税同形（keep 窗口
  每 turn 老化一对）；`clear_at_least` 只在激活边缘造成一次台阶；
- **H3**（结构性，不需 run）：TRC 无摘要环节，(b) 摘要缺陷指纹对它
  结构性不适用——**整清机制用 (a) 风险换掉 (b) 风险**。这是三列
  账本里第一格不需要实验就能填的：由机制构造直接推出。

对应实验 EXP-TRC-1（三臂对照）、EXP-TRC-2（clear_at_least ∈
{0, 5k, 20k} 价格扫描——给该参数的第一条实测曲线）、EXP-TRC-3
（clear_tool_inputs 强对照；前置债：死径清除的独立计数）。全部
预注册待执行，排在既定实验队列之后。

## 4. 诚实边界

- 本文零 TRC 测量数字；§3.3 全部为预注册假设，方向可能被推翻；
- 分歧表 D4/D5（error result 可清性、excludeTools 与 keep 名额）
  现为「已裁（推定）」，探针执行前不得当作官方行为引用；
- 单 harness（pi）、单 provider 家族（OpenAI-compatible/DeepSeek）；
  estimator 单位为估计值非真 token（D2/D6），跨 run 可比、跨
  tokenizer 不可比；
- LangChain 对照基于其 `context_editing.py` 当前版源码审读，上游
  修复后本文相应段落应更新（发现本身作为时点事实仍成立）。

## 5. 程序视角

本案例是「context 剪裁系统学」的第一个 frontier 批次（B1）。机制
全录 × 可行性矩阵下，可复刻批次候选依次为 thinking clearing
（DeepSeek reasoner 场景独有数据位；前置核证 provider reasoning
回放规则）、初始上下文重注入、cache-aware pinning（前置遥测单位
对账）；结构性不可复刻者（远端 opaque compact、subagent 隔离）转为
行为探针、上游 issue 与 failure-economics 案例库。终局产出：机制
横评比较章（并入 paper-context-economy v2）、插件套件、上游贡献。

## 内部依据（file-level，外发时替换为 repo 固定链接）

`docs/arch-frontier-pruning-design-2026-07-08.md`（规格、Rulings、
分歧表 D1-D11、PROBE-TRC）；`docs/g4-frontier-pruning-packets-2026-07-08.md`
（三 packet 验收全记录）；`docs/program-context-pruning-2026-07-08.md`
（机制矩阵与批次）；`docs/note-projection-turn-variables-2026-07-08.md`
（门控自污染实测）；`docs/note-landscape-compaction.md`（14 机制
调研与 taxonomy→economics 表）；`packages/context-pruning/`、
`extensions/frontier-pruning/`、`experiments/`（实现与测试）。

# Roadmap — dogfooding：从验证台到日常主力

2026-07-05。前提：G0–G1c 完成，coding agent loop 有保证。本篇回答：ecode
（pi + deterministic-compaction extension）如何变成日常可用的 coding agent，
且**日常使用本身持续产出实验级数据**——dogfooding 不是实验的替代，是实验的
环境化：G2 是受控配对，dogfooding 是常开观测面下的自然采样。

判定纪律不变：日常数据是轶事级，除非配对；但轶事负责发现新失效模式，
受控 run 负责坐实。

## 免费件盘点（pi 已有，勿重建）

| 能力 | 位置 | 状态 |
| --- | --- | --- |
| AGENTS.md / CLAUDE.md 自动加载 | `resource-loader.ts:68`（四种大小写候选） | 免费 |
| skills（SKILL.md 约定） | `src/core/skills.ts` | 免费 |
| context 占用百分比（footer 实时） | `footer.ts:109-114`，`session.getContextUsage()` 已正确处理 compaction | 免费 |
| slash command / flag / renderer 注册 | `ExtensionAPI.registerCommand/registerFlag/registerMessageRenderer` | 免费（挂 extension） |
| 项目级 settings（extension 路径、参数） | `.pi/settings.json`（survey Item 6） | 免费 |
| MCP client | — | **缺口**（源码无 MCP 支持） |

## D0 · 日常可用基线

- provider 真 key 接入（DeepSeek 主力 + 备选），推荐参数 `keep=3`/`compact-after=32k` 为默认。
- 全局 `~/.pi/agent/extensions/` 挂 deterministic-compaction（所有项目生效），
  项目级 settings 可覆盖参数。
- 用它做真实日常任务一周，不看数字，只记「哪里不顺手」。
- 出口：连续若干天不需要回退到其他 agent。

## D1 · 可观测性常开

- **compaction 可视化**：extension 注册 `/compaction` 命令族——移植 taucode 的
  `/compact-status`（trigger state、raw/compacted token、当前门控位置）、
  `/compact-diff`（per-message 投影差异）、`/compact-report`。数据源就是
  compaction-core 的 `projectCompaction()` 报告 shape，零新逻辑。
- **context window 可视化增强**：footer 的百分比之外，registerMessageRenderer
  渲染一条 compaction 触发标记线（第几 turn、压掉多少、门控阈值），让触发
  从静默事件变成可见事件。
- **常开 telemetry**：每个日常 session 后台落一份 G1c schema 的 JSONL
  （token、tool-call、re-read、compacted-path re-read 率、cacheRead），
  写到 `experiments/results/ambient/`。日常使用即数据积累。
- 出口：任何一次「感觉变笨了」都能回查到当时的投影状态与触发点。

## D2 · 自改配置（runtime policy 的雏形）

- `/compaction set keep-recent=5`、`/compaction set compact-after=64k`：
  运行中调参，写回 project settings，下一 turn 生效。
- `/compaction off|on`：负区间工作流（直接转换型）的手动逃生门，
  对应 roadmap 的「cost control 做成 loop 内 runtime policy」方向——
  先做成手动，积累「人在什么时候想关它」的样本，再谈自动策略。
- 出口：一周内每次手动调参都有 ambient 记录可回放。

## D3 · 生态兼容

- **AGENTS.md**：已免费，只需验证与 compaction 的交互——它进 ImmutablePrefix
  区（字节稳定），确认不被投影碰到。
- **skills**：已免费，同上验证；skill 内容大文件读取正好是曲线 A 的测试面。
- **MCP bridge（真工作项）**：写一个 extension，用 `registerTool` 把 MCP server
  的 tools 代理成 pi tools（stdio transport 起步，@modelcontextprotocol/sdk 做
  client 侧）。注意 cache 纪律：MCP tool specs 注入必须落在稳定前缀区，
  server 列表变更视同前缀重置。范围：先支持 1-2 个自用 server，不做通用聚合器。
- 出口：日常任务不因「缺某个工具」而切换到别的 agent。

## D4 · loop engineering（G3 种子，不等 G2 数据）

三档位模型的对角线：用第二档（动态投影）偷第三档（subagent 隔离）的收益。

- **narration-masking 投影**：review 相位压掉 assistant 叙事、保留原始证据
  （diff/tool result/失败记录）——现有投影的对偶。G1a 的 strategies 注入点
  使它只是一组新 strategy 配置，不是新机制。
- `/review` 命令：同一 append-only log，切到 review 投影重新提问，
  一次前缀断裂后重新字节稳定。
- **预期优势区间**（先于数据写明，防事后偏置）：中长任务——全程 + review
  装得下、不触发全量 compaction 的区间内，投影审免冷启动税（subagent 须重读
  同一批文件）、保留完整工作语义，只付一次前缀断裂。区间下界之下 review
  本身不值得；上界之上父 context 已有损，subagent 定向 packet 可能反超。
- **受控实验**（可与 G2 并行设计）：预埋缺陷任务，三臂——同 context 裸审 /
  narration-masking 投影审 / fresh subagent 审——**× 任务长度梯度**（短/中/长，
  以 review 时刻 contextTokens 相对门控阈值定档）。指标：缺陷检出率 × token
  成本。找的是交叉点而非胜负。阴性照常入档。
- **规则化收益**：区间即使窄也可兑现——切换变量（review 时刻的
  `session.getContextUsage()` 对比阈值）harness 内免费可观测，实验结果直接
  编译成 dispatch policy：`context 低于交叉点 → in-loop 投影审，否则 fork
  subagent`。三档位混合体由此从人工分层判断变成可执行 runtime policy，
  与 D2 的手动调参样本合流。
- 界限诚实写明：投影隔离是 best-effort（污染还在证据选择集里），
  subagent 隔离是构造性——落差本身与 cache 契约跨层 vs 客户端尽力同形。

## 顺序与依赖

D0 → D1 → D2‖D3 → D4。G2 受控轮与 D0-D1 并行不冲突（同一 rig，
G2 用 workspace 隔离，dogfooding 用真实项目）；D4 的受控臂设计好后
可以插进 G2 的执行批次一起跑。

## 风险

- ambient telemetry 的隐私边界：JSONL 里有代码内容片段，results/ambient/
  不出本机、不进 git。
- dogfooding 自改的老坑（taucode 教训）：harness 改动仍走强模型 + packet 模式，
  被试模型不碰 D1-D4 的实现。
- MCP bridge 是范围蔓延高危区——「先支持自用的 1-2 个」是硬边界。

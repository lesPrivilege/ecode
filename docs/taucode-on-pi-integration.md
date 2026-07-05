# taucode × pi 集成方案（pi 摸底结果）

写于 2026-06-22。基于实读 `Projects/pi`（@earendil-works/pi 单仓）。
配合 `taucode-wrapup-2026-06.md` 使用：那篇是「搬什么」，这篇是「搬到哪、怎么搬、怎么验证」。

---

## 0. 选型结论

- 环境里只有 `pi`（"Pi Agent Harness Mono Repo"，earendil-works / badlogic），**没有独立的 oh-my-pi**。
- pi 已经够轻且 **self-extensible（hook/extension 系统）**，完全符合「不上重 harness、只把 compact 策略搬上去、polish 各层」的目标。**结论：fork pi，不另找 oh-my-pi。**
- pi 三个包：`pi-agent-core`（runtime + session state + compaction）、`pi-ai`（多 provider，含 OpenAI 兼容 → 可接 DeepSeek / Mimo）、`pi-coding-agent`（CLI + extensions）、`tui`。

## 1. 决定性发现：pi 自带 LLM-summary compaction = 免费 A/B 基线

`packages/agent/src/harness/compaction/compaction.ts`：pi 原生 compaction 就是**全量 LLM 摘要**——
- `shouldCompact`：`contextTokens > contextWindow - reserveTokens` 时触发；
- `findCutPoint`：保留约 `keepRecentTokens`（默认 20000）的近期，含 split-turn 处理；
- `generateSummary`：对更早历史做一次 LLM 调用，产出结构化 checkpoint（Goal / Progress / Decisions / Next Steps…），支持迭代更新旧摘要；
- 默认 `reserveTokens 16384` / `keepRecentTokens 20000`。

这正是 taucode 一直要对标的 "LLM full summary" 臂。**fork pi 等于白拿了对照组**——不用自己实现 full compaction（wrapup 里那条 TODO 可以划掉）。

## 2. 两个插入缝（都走 hook，不 fork pi core）

pi 的 loop（`agent-loop.ts:282`）在发请求前会调 `transformContext`，而 harness 把它接到 hook：

```
// agent-harness.ts:412
transformContext: async (messages) => {
  const result = await this.emitHook({ type: "context", messages: [...messages] });
  return result?.messages ?? messages;   // AgentMessage[] -> AgentMessage[]
}
```

**缝 A —— `context` hook（主缝）。** `ContextEvent { type:"context"; messages: AgentMessage[] }`，返回 `{ messages?: AgentMessage[] }`。这就是 taucode「send-time 确定性投影」的完美落点：taucode 的 `compactCodeProductions(messages)` 本来就是 `messages → messages` 纯函数。注册一个 context hook，把 pi 的 `AgentMessage[]` 投影后返回即可。**不持久化、不动 session 树**——正好对齐 taucode「不改写存储历史」的原则。

**缝 B —— `session_before_compact` hook（可选）。** `agent-harness.ts:696`：该 hook 可返回 `{ compaction }`，pi 就用它**替代**自己的 LLM `compact()`，并作为正式 compaction entry 持久化（`fromHook: true`）。用途：让确定性 compaction 也能落成 checkpoint，或做「确定性 + 必要时 LLM」的混合。

> 两缝可组合：缝 A 做每轮轻量投影（taucode 核心赌注），缝 B 在跨阈值时落持久 checkpoint。最小可行版本只用缝 A。

extension 注册：`pi-coding-agent` 有 extensions 系统（`packages/coding-agent/src/core/extensions/`，仓库根 `examples/extensions/*`）。把 compaction 写成一个 pi extension 注册 `context` hook 即可，**对上游 diff ≈ 一个扩展目录**。

## 3. 适配工作量：taucode `Message` ↔ pi `AgentMessage`

真正的工程量在类型适配（不是算法）。映射：

| taucode | pi | 备注 |
| --- | --- | --- |
| `Message{role,content,toolCalls,meta}` 扁平数组 | `AgentMessage` 联合：`user / assistant / toolResult / bashExecution / custom / branchSummary / compactionSummary` | pi 用 block 数组 |
| assistant.toolCalls[] | `assistant.content` 里的 `{type:"toolCall", name, arguments}` block | 压 write/edit args 改这里 |
| tool result message | `toolResult` message（`content` blocks + `isError` + `details`） | 压 read/bash/search/find result 改这里 |
| `meta.isError` | `toolResult.isError`（hook `ToolResultEvent` 也给 `isError/details`） | pi 原生提供，无需自造 |
| toolCallId 配对 | pi toolResult 带 `toolCallId`，assistant toolCall block 带 id | 配对逻辑可直接重写 |
| `keepRecentAssistantMessages` 窗口 | 在 `AgentMessage[]` 上重算 | 语义不变 |
| hashline `¶path#hash`（read 输出） | **待确认 pi `read` 输出格式**（`coding-agent/src/core/tools/read.ts`） | 若不同，path/hash 提取做成可注入或退化为 path+行数 |

→ 这就是 wrapup 里 "externalization" 三处可注入（strategy registry / tool-name 匹配 / path-hash 提取）落到 pi 上的具体形态。

## 4. 修正后的实验设计（直接回答「是否存在真实优势区间」）

同一个 pi harness、同一组任务、同一模型（Mimo / DeepSeek），跑 **3（+1）臂**：

| 臂 | 配置 | 来源 |
| --- | --- | --- |
| A. 无 compaction | 关掉原生 + 不挂 hook | pi 原生开关 |
| B. LLM-summary | pi 原生 compaction | **免费** |
| C. 确定性投影 | 挂 taucode `context` hook | 要搬的核心 |
| D.（可选）混合 | 阈值下用 C，跨阈值落 B/缝B checkpoint | hybrid |

指标沿用 P0：总 input/output token（**B 必须计入 summarizer 的 in+out**）、completion、re-read 次数、tool-call 次数、人工质量复核。优势区间假设要验证的是：长 session、code-production 重、便宜模型下，**C 在「总 token ↓ 且质量不劣化」上同时打赢 A 和 B**。这是同 harness 受控对比，比之前 taucode 自跑可信得多。

注意点：
- C 要保留 taucode 的 hybrid 行为，就在 hook 内按 token 阈值 gate（门下原样返回 messages，跨门才投影），保 prefix cache。
- token 估计：pi 有 `estimateContextTokens`（优先用 provider usage），直接复用，别再用 taucode 的 4-char 估算另搞一套。
- Mimo cache 仍无信号（与 wrapup 一致），cache 轴留给 DeepSeek API。

## 5. harness polish 清单（轻）

pi 已具备：session JSONL（`harness/session/`）、多 provider（pi-ai，OpenAI 兼容可接 DeepSeek/Mimo）、TUI、tool dispatch、approval、token 估计、原生 compaction。所以「polish」主要是接线，不是重写：

- [ ] DeepSeek / Mimo provider + model 在 pi-ai 配好（OpenAI 兼容 endpoint）
- [ ] 写 compaction extension，注册 `context` hook（缝 A）
- [ ] taucode 策略函数移植 + Message↔AgentMessage adapter（第 3 节）
- [ ] 阈值 gate + 复用 `estimateContextTokens`
- [ ] 三臂实验脚本（A/B/C 开关 + 报告，对齐 P0 指标）
- [ ]（可选）缝 B 持久化 checkpoint + `/compact-*` 观测

## 6. 待确认项（重建第一步去 pi 里核对）

1. pi `read` 工具输出格式（决定 path/hash 提取怎么写）——`coding-agent/src/core/tools/read.ts`。
2. extension 注册 API 的确切签名 —— `coding-agent/src/core/extensions/` + 根 `examples/extensions/`。
3. `context` hook 返回的 messages 是否影响 session 持久化（预期：仅 send 投影，不落盘——需确认）。
4. pi-ai 对 DeepSeek/Mimo 的 cache 字段处理（沿用 wrapup 的 cache 结论）。

---

### 一句话

fork pi（不是 oh-my-pi），把 taucode 的确定性 compaction 做成一个挂 `context` hook 的 pi extension；pi 自带的 LLM-summary 当对照组，三臂同台跑，看 C 是否真的在优势区间同时赢过 A 和 B。harness 几乎不用动，工程量集中在 `Message ↔ AgentMessage` 适配。

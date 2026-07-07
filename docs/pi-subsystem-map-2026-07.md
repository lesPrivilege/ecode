# pi Subsystem Map — Extension Lifecycle & Session Persistence (merged)

> **来源说明**：本文件由原躺在 `pi/`（`badlogic/pi-mono` 的 zero-diff fork，`pi/` 在外层仓库中 gitignored、自带 `.git`）内、git 未追踪的三份测绘文件迁出合并而成，2026-07-08（CHORE-3）执行。原文件：
> - `pi/SUBSYSTEM-MAP.md`
> - `pi/packages/coding-agent/SUBSYSTEM-MAP.md`
> - `pi/workspace/SUBSYSTEM-MAP.md`
>
> 迁出后，上述三项（含整个 `pi/workspace/` 目录）已从 `pi/` 内删除，`pi/.git/info/exclude` 已追加 `workspace/`。

## 图例与阅读须知

- `[R]` = 原 `pi/SUBSYSTEM-MAP.md`（根目录，中文为主）
- `[P]` = 原 `pi/packages/coding-agent/SUBSYSTEM-MAP.md`（英文）
- `[W]` = 原 `pi/workspace/SUBSYSTEM-MAP.md`（英文，行号引用粒度最细；文件头声明 "Paths relative to `/Users/lesprivilege/Projects/ecode/pi/`"）

**关于 file:line 引用的分歧**：三份原始测绘对同一函数/类/类型给出的行号大量互不一致——不是零星偏差，而是几乎每一条引用都有出入，个别情况下连**所在文件**都不一致（例如 `SessionTreeEntry` 联合类型的定义位置，`[R]` 记为 `extensions/types.ts:160`，`[P]`/`[W]` 记为 `harness/types.ts:409`，两者对同名类型给出不同的宿主文件）。这大概率是三次独立探测各自面对 `pi/`（随 upstream 同步演进的活分支）不同 checkout 状态下的结果，而非单纯笔误，但本次迁出合并**不核验、不裁决孰对孰错**，也不假设"以最新/最细者为准"。

合并原则：完全重复（同一事实、同一引用）只保留一份；同一事实但引用不同的，原样并列注明来源；仅某一份提到的细节全部保留；为使文档连贯，允许调整小节顺序与合并表格，但不改写、不裁剪、不新增任何事实性内容。

---

## 1. Extension Lifecycle（扩展生命周期：发现 → 加载 → 注册 → Hook 派发）

`[R]` 开篇定义：Extensions 是 TypeScript 模块，通过工厂函数 `ExtensionFactory`（`extensions/types.ts:1447`）接收 `ExtensionAPI`（`extensions/types.ts:1147`），可订阅 agent 生命周期事件、注册 LLM 可调用工具、命令、快捷键等。

### 1.1 Discovery（发现）

三份来源一致：扩展按优先级从三个来源被发现，入口都指向 `discoverAndLoadExtensions()` @ `extensions/loader.ts:651`（`[R][P][W]` 三方引用一致）。

三个来源渠道，逐条对照：

| # | 渠道 | `[R]` | `[P]` | `[W]` |
|---|---|---|---|---|
| 1 | 项目本地 | `${cwd}/.config/extensions/`（`extensions/loader.ts:674`） | `${cwd}/.pi/extensions/` | `<cwd>/.pi/extensions/`，来自 `CONFIG_DIR_NAME`（默认 `.pi`，`config.ts:491`），与 resolve 后的 cwd 拼接（`extensions/loader.ts:673–674`） |
| 2 | 全局 | `${agentDir}/extensions/`（`extensions/loader.ts:678`） | `${agentDir}/extensions/` | `~/.pi/agent/extensions/`，即 `getAgentDir()` → `join(homedir(), CONFIG_DIR_NAME, "agent")`（`config.ts:514–520`，`extensions/loader.ts:677–678`） |
| 3 | 显式路径 | `configuredPaths[]`（`extensions/loader.ts:683-694`） | 来自 settings 的 `extensions[]`（字符串数组，文件或目录路径） | 来自 settings `extensions[]`（字符串数组，文件或目录路径）（`extensions/loader.ts:680–691`） |

注：`[R]` 记录的项目本地路径是 `.config/extensions/`，`[P]`/`[W]` 均记录为 `.pi/extensions/`——三者中两方一致但与 `[R]` 不同，原样保留，不裁定。

单个目录的处理（`discoverExtensionsInDir()`，`[R][P]` 记 `extensions/loader.ts:614`；`[W]` 记 `extensions/loader.ts:592`）：

- 直接文件 `*.ts` / `*.js` → 直接加载为扩展（`[P]` code block: `extensions/loader.ts:618`；`[W]`: `extensions/loader.ts:607–610`）。
- 子目录含 `index.ts` / `index.js` → 加载该 index（`[W]`: `extensions/loader.ts:624–627`）。
- 子目录含 `package.json` 且声明 `pi.extensions` 字段 → 加载声明的入口点，经 `resolveExtensionEntries()`。三方对 `resolveExtensionEntries` 的终止行一致指向 `:572`：`[R]` 记 `extensions/loader.ts:572`（并额外指出 package.json 字段检查在 `extensions/loader.ts:576`，进一步调用 `readPiManifest` @ `extensions/loader.ts:546`——`readPiManifest` 这一具体函数名仅 `[R]` 提及）；`[P]` 记 `resolveExtensionEntries` 本体 `extensions/loader.ts:572`，其内部再分 `package.json pi.extensions` 检查（`loader.ts:578-590`）与 `index.ts`/`index.js` 回退（`loader.ts:593-602`）两支；`[W]` 记 `resolveExtensionEntries`，`extensions/loader.ts:547–572`。
- `[W]` 独有：不做超过一层的递归；更复杂的包必须使用 `package.json` manifest（`extensions/loader.ts:589–590`）。
- `[W]` 独有：跨渠道去重——`addPaths()`（`extensions/loader.ts:661–665`）用一个基于**已解析绝对路径**的 `seen` Set，确保同一扩展文件不会被加载两次。

### 1.2 Module Loading（模块加载）

三方一致的调用链：`loadExtensions()` → `loadExtensionsInternal()` → `loadExtension()`，均使用 **jiti** 做动态 import，并区分 Bun 二进制（走预 bundle 的 `VIRTUAL_MODULES`/`virtualModules`）与 Node.js/dev（走 `getAliases()` 的 path alias）两条路径。三方给出的具体行号互不相同：

| 环节 | `[R]` | `[P]` | `[W]` |
|---|---|---|---|
| `loadExtensions()` | `extensions/loader.ts:521` | （code block 同 `loader.ts:521`，未单独标号） | `extensions/loader.ts:430` |
| `loadExtensionsInternal()` | `extensions/loader.ts:481` | — | `extensions/loader.ts:394` |
| `loadExtension()` | `extensions/loader.ts:432` | `extensions/loader.ts:432` | `extensions/loader.ts:176`（内部含 `resolvePath(extensionPath, cwd)` @ `loader.ts:179`） |
| `loadExtensionModule()` | `extensions/loader.ts:381`，内部用 jiti 动态 import | `extensions/loader.ts:381`；`jiti.import(extensionPath, { default: true })` @ `loader.ts:401` | `extensions/loader.ts:79`；创建 jiti 实例 @ `loader.ts:84` |
| Bun 预 bundle 常量 | `VIRTUAL_MODULES`（`extensions/loader.ts:46`） | 通过 `virtualModules` 解析 bundled `@earendil-works/pi-*` 包 | `VIRTUAL_MODULES`（`extensions/loader.ts:36–55`），预 bundle 的包含 typebox、pi-ai、pi-tui 等；配置位置 `loader.ts:87` |
| Node/dev alias | `getAliases()`（`extensions/loader.ts:76`） | 通过 `aliases` 解析 workspace 包 | `getAliases()`（`extensions/loader.ts:73`），配置位置 `loader.ts:87` |
| 扩展工厂校验 | — | 期望默认导出为 `ExtensionFactory`（`types.ts:1612`） | 期望默认导出为 `ExtensionFactory = (pi: ExtensionAPI) => void \| Promise<void>`（`types.ts:1447`，与 `[R]` 一致）；非函数则报错（`loader.ts:190`） |
| 缓存 | `extensionCache`（`extensions/loader.ts:134`），经 `loadExtensionsCached()`（`loader.ts:530`）使用；`clearExtensionCache()`（`loader.ts:141`）在 cwd 变更时清除 | `Extension` 类型 @ `types.ts:1608`；`ExtensionRuntime` @ `loader.ts:160`（与 `[R]` 的 `createExtensionRuntime()` 行号一致） | `extensionCache` Map（`loader.ts:51`），以 resolved path 为 key，`generation` 计数器（`loader.ts:52`）判定 staleness，`clearExtensionCache()`（`loader.ts:57`） |
| 内联工厂 | `loadExtensionFromFactory()`（`extensions/loader.ts:463`） | 内联/临时来源见下方 `SourceInfo` | — |

`[P]` 额外给出的加载步骤代码骨架：`createExtension(extensionPath, resolvedPath)`（`loader.ts:411`，产出空的 `handlers/tools/commands` 等）→ `createExtensionAPI(extension, runtime, cwd, eventBus)`（`loader.ts:213`）→ `factory(api)`（`loader.ts:460`，调用用户的扩展工厂）。

### 1.3 Registration（注册，ExtensionAPI）

三方均描述：扩展工厂执行期间，通过 `ExtensionAPI` 的方法把能力写入该扩展专属的 `Extension` 对象；action 类方法（如 `sendMessage`）则委托给共享的 `ExtensionRuntime`。`createExtensionAPI()` 的定义行号：`[R]` 记 `extensions/loader.ts:301`；`[W]` 记 `extensions/loader.ts:100`。

注册方法一览（行号按来源分列）：

| API 方法 | 写入目标 | `[R]` | `[P]` | `[W]` |
|---|---|---|---|---|
| `on(event, handler)` | `extension.handlers`：`Map<event, HandlerFn[]>` | `loader.ts:306` | `loader.ts:368-371` | `loader.ts:110–114` |
| `registerTool(tool)` | `extension.tools`：`Map<name, RegisteredTool>` | `loader.ts:313`（并触发 `runtime.refreshTools()`） | `loader.ts:373-378` | `loader.ts:117–122` |
| `registerCommand(name, opts)` | `extension.commands`：`Map<name, RegisteredCommand>` | `loader.ts:321` | `loader.ts:380-385` | `loader.ts:125–130` |
| `registerShortcut(key, opts)` | `extension.shortcuts`：`Map<shortcut, ExtensionShortcut>` | `loader.ts:333` | `loader.ts:387-391` | `loader.ts:133–138` |
| `registerFlag(name, opts)` | `extension.flags`：`Map<name, ExtensionFlag>` | `loader.ts:343` | `loader.ts:393-399` | `loader.ts:141–147` |
| `registerMessageRenderer(type, fn)` | `extension.messageRenderers` | `loader.ts:351`（与 EntryRenderer 合并一行） | `loader.ts:401-403` | `loader.ts:150–152` |
| `registerEntryRenderer(type, fn)` | `extension.entryRenderers` | 同上 `loader.ts:351` | `loader.ts:405-409` | `loader.ts:155–157` |
| `registerProvider(name, config)` | 排队进 `runtime.pendingProviderRegistrations[]`，等 `bindCore()` 时 flush | 未单列此方法，但下文"运行时绑定"提到 provider registration 的 flush 行为 | `runner.ts:261`；flush 于 `ExtensionRunner.bindCore()`（`runner.ts:446-451`） | `loader.ts:158–162`；flush 于 `runner.ts:127–136` |

`ExtensionRuntime`（运行时绑定）：

- `[R]`：`createExtensionRuntime()`（`extensions/loader.ts:160`）创建带 throwing stub 的 runtime；`Runner.bindCore()`（`extensions/runner.ts:327`）将 runtime 的方法替换为真实实现，并 flush 队列中的 provider registrations。
- `[P]`：`ExtensionRuntime`（`createExtensionRuntime`，`extensions/loader.ts:160`，与 `[R]` 一致）。
- `[W]`：`createExtensionRuntime`（`loader.ts:65`）起始为一个所有 action 方法（`sendMessage`、`sendUserMessage`、`appendEntry`、`setModel` 等）均为 throwing stub 的壳；stub 在所有扩展加载完毕后由 `runner.bindCore()`（`runner.ts:102`）替换。

`[W]` 独有细节：

- **`Extension` 对象结构**（由 `createExtension` 产出，`loader.ts:159`）：`{ path, resolvedPath, sourceInfo, handlers, tools, messageRenderers, entryRenderers, commands, flags, shortcuts }`。
- **`SourceInfo` 推导**：`<inline>` / `<temporary>` → `source: "temporary"`，无 `baseDir`（`loader.ts:161–163`）；本地文件 → `source: "local"`，`baseDir = dirname(resolvedPath)`（`loader.ts:163–164`）。

`[R]` 独有细节：每个 extension 实例化为 `Extension` 对象时（`extensions/loader.ts:432` — `createExtension`），内部 `handlers`/`tools`/`commands`/`shortcuts`/`flags` 等 Map 均以空集合开始。

### 1.4 Hook Dispatch（Hook 派发，ExtensionRunner）

`ExtensionRunner` 是派发核心，持有 extensions 列表和共享 runtime。类本身的行号：`[R]` 记 `extensions/runner.ts:282`；`[W]` 记 `runner.ts:85`。

**Binding 阶段**（`[W]` 独有的汇总表；`bindCore` 行号三方分别引用不同数字）：

| 阶段 | 方法 | `[W]` | 另见 |
|---|---|---|---|
| Core context | `bindCore(actions, contextActions, providerActions?)` | `runner.ts:102` | `[P]` 记 `extensions/runner.ts:282`；`[R]` "Runner.bindCore()" 记 `extensions/runner.ts:327` |
| Command context | `bindCommandContext(actions?)` | `runner.ts:209` | `[P]` 记 `extensions/runner.ts:464` |
| UI context | `setUIContext(uiContext?, mode?)` | `runner.ts:236` | — |

`bindCore` 的行为（三方复述一致，细节互补）：

- `[P]`：拷贝 action 方法进 `runtime.sendMessage`、`runtime.sendUserMessage` 等；绑定 context providers（`getModel`、`isIdle`、`abort`、`getContextUsage` 等）；通过 `modelRegistry.registerProvider()` flush `pendingProviderRegistrations`。
- `[W]`：拷贝的 action 方法清单最详细——`sendMessage`、`sendUserMessage`、`appendEntry`、`setSessionName`、`getSessionName`、`setLabel`、`getActiveTools`、`getAllTools`、`setActiveTools`、`refreshTools`、`getCommands`、`setModel`、`getThinkingLevel`、`setThinkingLevel`（`runner.ts:104–119`）；flush `pendingProviderRegistrations`（`runner.ts:127–136`），随后将排队用的 stub 替换为直接调用（`runner.ts:139–152`）。
- `[P]`：`bindCommandContext` 绑定 `waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`。

**ExtensionContext**：

- `[R]`：`ExtensionContext`（`extensions/types.ts:301`）。`createContext()`（`extensions/runner.ts:647`）使用属性访问器（getter）实现惰性解析，确保每次访问都反映最新状态。`createCommandContext()`（`extensions/runner.ts:718`）在上下文基础上附加 session 操作（`newSession`/`fork`/`navigateTree`/`switchSession`/`reload`）。
- `[W]`：`createContext`（`runner.ts:286`）返回带**惰性属性描述符**的 `ExtensionContext`——值在调用时解析，反映 runner 的实时状态。属性清单（`runner.ts:289–345`）：`ui`、`mode`、`hasUI`、`cwd`、`sessionManager`、`modelRegistry`、`model`、`isIdle()`、`isProjectTrusted()`、`signal`、`abort()`、`shutdown()`、`getContextUsage()`、`compact()`、`getSystemPrompt()`。`createCommandContext`（`runner.ts:350`）在此基础上扩展会话控制方法：`getSystemPromptOptions`、`waitForIdle`、`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`（`runner.ts:360–382`）——比 `[R]` 列出的 5 个方法多出 `getSystemPromptOptions` 与 `waitForIdle`。

**事件分发方法**（三方均给出方法清单，行号与覆盖面不完全重叠，合并为一张总表；"返回类型"列仅 `[W]` 给出）：

| 方法 | 语义 | `[R]` | `[P]` | `[W]`（含返回类型） |
|---|---|---|---|---|
| `emit(event)` | 通用事件广播；`session_before_*` 事件可被 `{cancel:true}` 短路 | `runner.ts:766` | 1.5a 通用 `emit()`：`runner.ts:628`；签名 `async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>>` | `runner.ts:381`；返回 `RunnerEmitResult` |
| `emitToolCall(event)` | tool_call 事件，支持 `block` 短路和输入可变 | `runner.ts:892` | 阻断或放行 tool call：`runner.ts:802` | `runner.ts:466`；返回 `ToolCallEventResult \| undefined` |
| `emitToolResult(event)` | 修改 `content`/`details`/`isError` | `runner.ts:842` | `runner.ts:772` | `runner.ts:441`；返回 `ToolResultEventResult \| undefined` |
| `emitContext(messages)` | 修改发给 LLM 前的 messages 数组 | `runner.ts:944` | `runner.ts:827` | `runner.ts:504`；返回 `AgentMessage[]` |
| `emitBeforeProviderRequest(payload)` | 替换 provider 请求 payload | `runner.ts:983` | `runner.ts:876` | `runner.ts:521`（对应事件名 `before_provider_request`）；返回 `unknown` |
| `emitMessageEnd(event)` | 替换最终化的 assistant 消息 | `runner.ts:801` | `runner.ts:723` | `runner.ts:421`；返回 `AgentMessage \| undefined` |
| `emitBeforeAgentStart(...)` | 注入消息 / 替换 system prompt；`[P]` 给出签名 `(prompt, images, sysPrompt, opts)` | `runner.ts:1016` | `runner.ts:921` | `runner.ts:528`（对应事件名 `before_agent_start`）；返回 `BeforeAgentStartCombinedResult \| undefined` |
| `emitResourcesDiscover(cwd, reason)` | 获取扩展提供的附加 skill/prompt/theme 路径 | `runner.ts:1082` | `runner.ts:925` | `runner.ts:548`（对应事件名 `resources_discover`）；返回 `{ skillPaths, promptPaths, themePaths }` |
| `emitUserBash(event)` | 处理 `!`/`!!` bash 命令，支持提供替代 result | `runner.ts:916` | `runner.ts:852` | `runner.ts:488`；返回 `UserBashEventResult \| undefined` |
| `emitInput(text, images, source, ...)` | input 事件，支持 `continue`/`transform`/`handled` | `runner.ts:1131` | `runner.ts:975` | `runner.ts:573`；返回 `InputEventResult` |
| `emitProjectTrust(event, ctx)` | 静态函数，独立于 emit 链——**仅 `[R]` 提及** | `runner.ts:218` | — | — |

**通用 `emit()` 派发语义**（三方复述基本一致）：遍历所有 extensions，对每个 extension 的 handlers 按注册顺序执行；`session_before_*` 事件若 handler 返回 `{cancel: true}` 立即短路（`[R]` 记该判断在 `runner.ts:772`；`[W]` 记 `runner.ts:397–399`）。`[W]` 独有：错误被捕获并转发给 `emitError`（`runner.ts:400–406`），不会向上抛出。

**Stall / stale 保护**：

- `[R]`：`invalidate()`（`extensions/runner.ts:466`）在 session 替换/reload 后标记所有捕获的 ctx 为 stale，调用任何方法都会抛出。
- `[W]`：`invalidate()`（`runner.ts:281`）设置一个 stale flag，使之后所有 `assertActive()` 检查（`runner.ts:293`）抛出；用于 session 替换或 reload 之后。

**Tool 包装**：`wrapRegisteredTool()` / `wrapRegisteredTools()` 将 `RegisteredTool`（`[W]` 用词 `ToolDefinition`）适配为 `AgentTool`，通过 `runner.createContext()` 提供一致的执行上下文。行号：`[R]` 记 `wrapper.ts:17` / `wrapper.ts:25`；`[W]` 记 `wrapper.ts:18` / `wrapper.ts:26`。

### 1.5 AgentHarness ↔ Extension Bridge

`AgentHarness` 类的行号：`[W]` 记 `agent-harness.ts:146`；`[R]`（见 2.7）记其"事件桥接"起点在 `agent-harness.ts:157`。

两套订阅 API（`[P]`/`[W]` 一致提及，行号有出入）：

| API | 事件范围 | `[P]` | `[W]` |
|---|---|---|---|
| `subscribe(listener)` | 全部 `AgentHarnessEvent`（`"*"` 通配） | `agent-harness.ts:1003` | `agent-harness.ts:968–978` |
| `on(type, handler)` | 类型化的 harness 内部事件（`before_provider_request`、`tool_call` 等），可返回结果 | `agent-harness.ts:1019` | `agent-harness.ts:984–997` |

内部派发方法（`[P]`/`[W]` 在此处的行号一致）：

- `emitOwn(event)` — 只广播给 `"*"` 订阅者（内部 harness 订阅者）—— `agent-harness.ts:212`（`[P][W]` 一致）。
- `emitAny(event)` — 广播给 `"*"` 订阅者（内部 + 经 `subscribe` 的外部）—— `agent-harness.ts:222`（`[P][W]` 一致）。
- `emitHook(event)` — 派发给 `on()` 注册的类型化 handler，可返回结果（`context`、`tool_call`、`tool_result`、`session_before_compact`、`session_before_tree` 等）—— `agent-harness.ts:232`（`[P][W]` 一致）。`[W]` 补充：返回最后一个非 `undefined` 的结果；`emitOwn`/`emitAny` 的错误被包装为 `AgentHarnessError("hook")`。

`[P]` 给出的事件类型 → 派发行号清单（从 `AgentHarness` 内部发出）：

| 事件 | 行号 |
|---|---|
| `context` | `agent-harness.ts:409`（经 `createLoopConfig.transformContext`） |
| `tool_call` | `agent-harness.ts:413`（经 `beforeToolCall`） |
| `tool_result` | `agent-harness.ts:422`（经 `afterToolCall`） |
| `session_before_compact` | `agent-harness.ts:700` |
| `session_before_tree` | `agent-harness.ts:755` |
| `session_compact` | `agent-harness.ts:722` |
| `session_tree` | `agent-harness.ts:814` |
| `model_update` | `agent-harness.ts:842` |
| `thinking_level_update` | `agent-harness.ts:861` |
| `tools_update` | `agent-harness.ts:889` |
| `resources_update` | `agent-harness.ts:959` |
| `before_agent_start` | `agent-harness.ts:548` |
| `after_provider_response` | `agent-harness.ts:373` |
| `save_point` | `agent-harness.ts:504` |
| `settled` | `agent-harness.ts:511` |
| `abort` | `agent-harness.ts:988` |

`[W]` 给出的是同一事件族在**类型定义处**（而非各自的发出点）的清单——`AgentHarnessOwnEvent`（`types.ts:596–609`）：`queue_update`、`save_point`、`abort`、`settled`、`before_agent_start`、`context`、`before_provider_request`、`before_provider_payload`、`after_provider_response`、`tool_call`、`tool_result`、`session_before_compact`、`session_compact`、`session_before_tree`、`session_tree`、`model_update`、`thinking_level_update`、`resources_update`、`tools_update`。（`queue_update`、`before_provider_request`、`before_provider_payload` 三个事件名未出现在 `[P]` 的发出点清单中，为 `[W]` 独有補充。）

`[R]` 描述的桥接语义（`AgentHarness` 通过 `subscribe()` @ `agent-harness.ts:375` 接收 agent-core 的 `AgentEvent`，`type: "message_end"`/`"turn_end"`/`"agent_end"` 等）：

- `message_end`：写入 session（`session.appendMessage`）+ 广播给订阅者。
- `turn_end`：flush pending session writes + 发 `save_point` 事件。
- `agent_end`：flush pending writes + 设 `phase=idle`。

同时 `emitOwn()` 发送 `AgentHarnessOwnEvent`（如 `model_update`/`session_compact`/`session_tree` 等），供上层（如 coding-agent 的 `ExtensionRunner`）代理到扩展事件系统。（pending session writes 的机制细节见下文 § 2.9。）

---

## 2. Session Persistence（会话持久化）

### 2.1 Architecture Overview（架构总览）

`[W]` 给出的整体关系图（仅此份含 ASCII 图）：

```
SessionRepo ─── creates/opens ──→ Session ─── wraps ──→ SessionStorage
                                                                  ↑
                                                   ┌──────────────┴──────────────┐
                                            JsonlSessionStorage        InMemorySessionStorage
                                                   ↓
                                            JSONL files on disk
```

- **Session**（`session/session.ts:25`，`[W]`）包裹一个 `SessionStorage`，提供带类型的 append/get/traverse 方法。`[R]` 另给出 "Session 类" 的行号为 `session.ts:82`（见 § 2.5，与 `[W]` 的 25 不一致）。
- **`SessionStorage` 接口**：`[W]` 记 `types.ts:438–454`；`[P]` 记 `harness/types.ts:440`（两者相近）。方法：`getMetadata`、`getLeafId`/`setLeafId`、`createEntryId`、`appendEntry`、`getEntry`、`findEntries`、`getLabel`、`getPathToRoot`、`getEntries`（`[P]` 以 TypeScript 接口代码块给出，`[W]` 以清单给出，二者一致）。
- **`SessionRepo` 接口**（仅 `[W]` 明确给出）：`types.ts:456–465`，方法 `create`、`open`、`list`、`delete`、`fork`。
- 两种实现（三方一致）：`JsonlSessionRepo` + `JsonlSessionStorage`（文件系统）；`InMemorySessionRepo` + `InMemorySessionStorage`（内存，供测试/无持久化场景使用）。

### 2.2 Session Tree Entry Types（会话树 Entry 类型）

三方均给出 11 种 entry 类型的清单，字段与用途描述基本一致；**分歧点在于宿主文件路径与行号**：

- `[R]`：base 接口 `SessionTreeEntryBase` @ `extensions/types.ts:105`；联合类型 `SessionTreeEntry` @ `extensions/types.ts:160`。
- `[P]`：base 接口 `SessionTreeEntryBase` @ `harness/types.ts:334`；联合类型 `SessionTreeEntry` @ `harness/types.ts:409`。字段代码块：`{ type, id, parentId, timestamp }`。
- `[W]`：base 接口 @ `types.ts:334–338`；联合类型 @ `types.ts:409–421`（数值与 `[P]` 的 `harness/types.ts` 高度接近，推测指向同一文件；但 `[W]` 未显式写出 `harness/` 前缀）。

即：`[R]` 记录该类型体系位于 `extensions/types.ts`（行号 105/160 区间，较小）；`[P]`/`[W]` 记录位于 `harness/types.ts`（行号 334/409 区间，较大）。两个文件路径都原样保留，不做取舍。

11 种 entry 类型合并表：

| 类型名（discriminator） | 核心字段 | 用途 | `[R]` | `[P]` | `[W]` |
|---|---|---|---|---|---|
| `MessageEntry`（`"message"`） | `message: AgentMessage` | 用户/助手/工具消息 | `types.ts:109` | `harness/types.ts:337` | `types.ts:341–344` |
| `ThinkingLevelChangeEntry`（`"thinking_level_change"`） | `thinkingLevel: string` | 思维等级变更 | `types.ts:113` | `harness/types.ts:341` | `types.ts:346–349` |
| `ModelChangeEntry`（`"model_change"`） | `provider, modelId` | 模型/provider 切换 | `types.ts:118` | `harness/types.ts:347` | `types.ts:351–355` |
| `ActiveToolsChangeEntry`（`"active_tools_change"`） | `activeToolNames: string[]` | 活跃工具集合变更 | `types.ts:123` | `harness/types.ts:353` | `types.ts:357–360` |
| `CompactionEntry`（`"compaction"`） | `summary, firstKeptEntryId, tokensBefore, details?, fromHook?` | 上下文压缩记录 | `types.ts:128` | `harness/types.ts:362` | `types.ts:362–368` |
| `BranchSummaryEntry`（`"branch_summary"`） | `fromId, summary, details?, fromHook?` | 分支导航摘要 | `types.ts:137` | `harness/types.ts:371` | `types.ts:371–377` |
| `CustomEntry`（`"custom"`） | `customType, data?` | 扩展自定义持久化（不进 LLM 上下文） | `types.ts:144` | `harness/types.ts:378` | `types.ts:379–383` |
| `CustomMessageEntry`（`"custom_message"`） | `customType, content, display, details?` | 扩展自定义消息（对 LLM 可见） | `types.ts:149` | `harness/types.ts:384` | `types.ts:385–391` |
| `LabelEntry`（`"label"`） | `targetId, label \| undefined` | 用户书签/标签 | `types.ts:156` | `harness/types.ts:393` | `types.ts:393–397` |
| `SessionInfoEntry`（`"session_info"`） | `name?` | 会话显示名（legacy 命名保留） | `types.ts:161` | `harness/types.ts:399` | `types.ts:399–401` |
| `LeafEntry`（`"leaf"`） | `targetId: string \| null` | 叶子指针，记录当前活跃分支位置 | `types.ts:165` | `harness/types.ts:404` | `types.ts:404–407` |

### 2.3 SessionStorage 实现

**`JsonlSessionStorage`**（`session/jsonl-storage.ts`；类定义行号仅 `[P]` 给出：`jsonl-storage.ts:10`）：

- 文件格式 JSONL：第一行为 `SessionHeader`（`[R]`: `jsonl-storage.ts:29`，version 3；`[W]` 在 § 2.6 给出更细的头部形状，见下）。
- 每行一个 JSON entry，结尾的 `leaf` entry 标记当前叶子（`[R]`）。
- `getPathToRoot(leafId)`：从叶子沿 `parentId` 链追溯至根。`[R]` 记 `jsonl-storage.ts:275`；`[W]` 记 `jsonl-storage.ts:256`。
- `appendEntry(entry)`：追加到文件 + 内存缓存。`[R]` 记 `jsonl-storage.ts:264`。
- 标签缓存：`labelsById` Map，从 `label` entry 增量更新。`[R]` 记 `jsonl-storage.ts:35`；`[P]` 给出具体构建函数名 **`buildLabelsById()`**（`[R]`/`[W]` 均未点名此函数），行号 `session/jsonl-storage.ts:31`；`[W]` 在 § 2.8 记为 `jsonl-storage.ts:35–41`。
- **Entry ID 生成**（仅 `[R]` 提及）：`uuidv7().slice(0, 8)`，碰撞重试最多 100 次（`jsonl-storage.ts:44`）。
- `[W]` 补充：storage 维护 `currentLeafId`（`jsonl-storage.ts:99`），每次 append 后更新。

**`InMemorySessionStorage`**（`memory-storage.ts`）：同接口，仅驻留内存，用于测试/无持久化场景（三方一致）。类定义行号：`[P]` 记 `session/memory-storage.ts:40`。`buildLabelsById` 在此实现中的对应位置：`[P]` 记 `memory-storage.ts:15`；`[W]` 记 `memory-storage.ts:20–26`。

### 2.4 Session Repositories、Fork 与 JSONL 文件格式

**Repo 层**：

| 实现 | 文件 | 功能 | 备注 |
|---|---|---|---|
| `JsonlSessionRepo` | `jsonl-repo.ts` | CRUD + fork，基于文件系统 | 行号：`[R]` 记类本体 `jsonl-repo.ts:38`；`[P]` 记 `session/jsonl-repo.ts:1`；`[W]` 记 `fork()` 方法本体 `jsonl-repo.ts:119` |
| `InMemorySessionRepo` | `memory-repo.ts` | CRUD + fork，内存 Map | `[R]` 记 `memory-repo.ts:5`；`[P]` 记 `session/memory-repo.ts:1` |

`[R]` 描述的通用方法语义：`create()` 生成 `uuidv7` ID + ISO 时间戳，创建 storage 实例；`open(metadata)` 从持久化 metadata 加载 session；`list()` 扫描目录下所有 `.jsonl` 文件（Jsonl），或返回内存中所有 session（InMemory）。

`[P]` 补充：`JsonlSessionRepo` 将 session 存为 `{timestamp}_{id}.jsonl` 文件，按 cwd 目录组织（编码为 `--{cwd-slug}--`）。`[W]` 给出对应的具体行号：文件路径模式 `<sessions-dir>/<cwd-encoded>/<timestamp>_<sessionId>.jsonl`（`jsonl-repo.ts:95–100`），cwd 编码函数 `encodeCwd`（`jsonl-repo.ts:26`）。

**Fork（`getEntriesToFork`）**：

- `[R]`：`fork(source, options)` 调用 `getEntriesToFork()`（`repo-utils.ts:30`）→ 根据 `entryId`/`position` 确定有效叶子，复制路径到新 session。
- `[P]`：`getEntriesToFork(storage, options)`（`session/repo-utils.ts:28`）返回要复制进 fork 会话的 entries：无 `entryId` → 复制全部；`position: "at"` → 复制路径直到（含）目标 entry；`position: "before"`（默认）→ 复制路径直到目标 entry 的 parent（要求目标是 user message）。
- `[W]`：`JsonlSessionRepo.fork()`（`jsonl-repo.ts:119`）打开源、调用 `getEntriesToFork()`（`repo-utils.ts:22`——与 `[P]` 的 `:28` 不同）选择 entries、创建新 JSONL 文件、复制 entries。Fork position：`"before"`（默认，切在目标 parent 之前）或 `"at"`（包含目标 entry）（`repo-utils.ts:26–37`）。

**JSONL 文件格式**（仅 `[W]` 给出完整规格；`[R]` 在 § 2.3 提及 header 为 version 3）：

- 第 1 行：session header —`{ type: "session", version: 3, id, timestamp, cwd, parentSession? }`（`jsonl-storage.ts:21–26`）。
- 第 2 行起：每行一个 JSON `SessionTreeEntry`。
- Header 版本校验：`parseHeaderLine`（`jsonl-storage.ts:72`）拒绝非 `"session"` 类型和非 `3` 版本。
- Entry 校验：`parseEntryLine`（`jsonl-storage.ts:107`）校验 `type`、`id`、`parentId`、`timestamp`。

**Tree 结构**（append-only tree，仅 `[W]` 明确以此角度描述）：

- Session 是一棵 append-only 树，不是线性日志：每个 entry 的 `parentId` 指向它被追加时的上一个叶子。
- `LeafEntry` 记录一次重定向：当 `moveTo()` 导航到不同分支时，追加一个 `targetId` 指向新位置的 `LeafEntry`（`session.ts:157`，`types.ts:404–407`）。

### 2.5 Session 类（Facade）

Session 类本体行号：`[R]` 记 `session.ts:82`；`[W]` 记 `session/session.ts:25`（二者不一致）。

`[R]` 给出的方法清单：

- `buildContext()`（`session.ts:115`）：调用 `buildSessionContext()`（`session.ts:22`）→ 从 `getBranch()` 的路径 entry 重建 `SessionContext`（messages + model + thinkingLevel + activeToolNames）。
- `getBranch(fromId?)`（`session.ts:109`）：获取从叶子到根的 entry 路径。
- `appendMessage()`（`session.ts:132`）：追加 `MessageEntry`，`parentId` 设为当前叶子。
- `appendCompaction()`（`session.ts:173`）：追加 `CompactionEntry`。
- `appendCustomEntry()`（`session.ts:192`）：追加 `CustomEntry`。
- `appendLabel(targetId, label)`（`session.ts:218`）：校验 target 存在后追加 `LabelEntry`。
- `moveTo(entryId, summary?)`（`session.ts:247`）：树导航核心——设置新叶子（`setLeafId`），可选生成 `BranchSummaryEntry`。
- `getSessionName()`（`session.ts:117`）：从最近的 `session_info` entry 读取。

`[P]`/`[W]` 对同几个方法给出的行号大量不同（并互相之间也不同），原样列出：

| 方法 | `[R]` | `[P]` | `[W]` |
|---|---|---|---|
| `getBranch()` | `session.ts:109` | （未单独提及行号） | `getPathToRoot` 供 `getBranch()` 使用，`[W]` 记 `getBranch()` 本体 `session.ts:45` |
| `appendCompaction()` | `session.ts:173` | `session/session.ts:91` | 创建 `CompactionEntry` 的具体赋值在 `session.ts:107–119`（由 `agent-harness.ts:713–718` 调用） |
| `moveTo()` | `session.ts:247` | `session/session.ts:115` | 章节标题标注 `session/session.ts:115`（与 `[P]` 一致）；内部 `storage.setLeafId()` 调用点 `session.ts:157`，`BranchSummaryEntry` 追加点 `session.ts:166–173` |
| `appendLabel()` | `session.ts:218` | `session/session.ts:109` | — |
| `buildSessionContext()` | `session.ts:22` | `session/session.ts:22`（与 `[R]` 一致） | `session.ts:14` |
| `getSessionName()` | `session.ts:117` | — | `session.ts:55-57`（在 § 2.10 给出） |

注：`[R]` 的 `getBranch()`（`session.ts:109`）与 `[P]` 的 `appendLabel()`（`session/session.ts:109`）引用了同一行号却指向不同方法名，原样并列，不做取舍。

**`buildSessionContext` 核心逻辑**（三方均描述，细节互补）：

- `[R]`：1）扫描路径，提取最后的 thinkingLevel、model、activeToolNames、compaction；2）若存在 compaction，只保留 `firstKeptEntryId` 之后的 entry + compaction summary message；3）`branch_summary`/`custom_message` entry 也转为消息。
- `[P]`：处理 compaction 的方式——1）将 `createCompactionSummaryMessage()` 放在最前（`session/session.ts:41`）；2）在 compaction 的 prefix 中找到 `firstKeptEntryId` 之后的 entries；3）追加 compaction entry 之后的所有 entries。
- `[W]`：扫描 `thinking_level_change`/`model_change`/`active_tools_change`/`compaction` 构建 context 元数据；对 compaction entries，先发出 `CompactionSummaryMessage`，再跳过 `firstKeptEntryId` 之前的 entries（`session.ts:56–65`——即被压缩的 entries 仍留在树中，但从 context 中排除）；对 `branch_summary` entries，发出 `BranchSummaryMessage`；最终生成 `SessionContext = { messages, thinkingLevel, model, activeToolNames }`。

### 2.6 Compaction（压缩）

三方均给出压缩流程链条，步骤基本对应但行号普遍不同；合并为一条带多源标注的流程：

```
AgentHarness.compact()                       — agent-harness.ts:686（[R][P] 一致）
  → session.getBranch()                      — session.ts:109 [R]；调用点 agent-harness.ts:694 [P]
  → prepareCompaction()                      — compaction.ts:438 [R]；调用点 agent-harness.ts:695 [P][W]
      → findCutPoint()                       — compaction.ts:296 [R]，保留最近 ~keepRecentTokens（仅 [R]）
      → 识别 messagesToSummarize + turnPrefixMessages（split turn 场景，仅 [R]）
      → 提取 file operations（仅 [R]）
  → emitHook("session_before_compact")       — agent-harness.ts:700（[R][P][W] 一致）；可取消或提供替代结果 { cancel, compaction }（[W] 明确给出返回形状，[W] 记 700–705/709）
  → compact()                                — compaction.ts:559 [R]；调用点 agent-harness.ts:710 [P][W]
      → generateSummary()                    — compaction.ts:388，调用 LLM 生成结构化摘要（仅 [R]）
      → 或 generateTurnPrefixSummary()（split turn，仅 [R]）
      → formatFileOperations()（追加文件操作列表，仅 [R]）
  → session.appendCompaction()               — session.ts:173 [R]；agent-harness.ts:713 [P]；agent-harness.ts:713–718 调用、session.ts:107–119 创建 entry [W]
  → emitOwn("session_compact")               — agent-harness.ts:722（[R][P][W] 一致）
```

`[R]` 独有的关键常量：

- `DEFAULT_COMPACTION_SETTINGS`（`compaction.ts:90`）：`{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`。
- `SUMMARIZATION_PROMPT`（`compaction.ts:330`）：结构化摘要模板（Goal / Constraints / Progress / Key Decisions / Next Steps / Critical Context）。
- `estimateTokens()`（`compaction.ts:262`）：字符数 / 4 的启发式 token 估算。

`CompactionEntry` 字段回顾（`[P]`/`[W]` 一致）：`summary`（LLM 生成的摘要文本）、`firstKeptEntryId`（未被压缩的第一个 entry ID）、`tokensBefore`（压缩时的 token 计数）、`details?`（扩展专属元数据）、`fromHook?`（为 `true` 时表示该压缩结果由扩展 hook 提供，而非 pi 自身的 `compact()`）。

`[W]` 独有：**`fromHook` 的下游影响**——在后续压缩中，若上一次压缩是 hook 来源，其 `details` 会在文件操作提取时被跳过：`compaction.ts:43`: `if (!prevCompaction.fromHook && prevCompaction.details) { ... }`。

### 2.7 Branch Navigation（树导航）

三方均给出 `navigateTree()` 流程链条，`AgentHarness.navigateTree(targetId)` 本体行号三方各异：`[R]` 记 `agent-harness.ts:732`；`[P]` 记 `agent-harness.ts:737`；`[W]` 记 `agent-harness.ts:740`。合并流程：

```
AgentHarness.navigateTree(targetId)
  → 确认 targetId 不是当前叶子（[R] 表述）／取得 old leaf、target entry、common ancestor（[P] 记 agent-harness.ts:743/748；[W] 记 747–749）
  → collectEntriesForBranchSummary()          — branch-summarization.ts（仅 [R] 点名此文件；[P] 记调用点 agent-harness.ts:748）
  → emitHook("session_before_tree")           — agent-harness.ts:762 [R]；:755 [P]；:768 [W]（三者均不同）；扩展可取消或提供 summary
  → generateBranchSummary()                   — branch-summarization.ts（仅 [R] 点名此文件），若 summarize=true；调用点 agent-harness.ts:763 [P]；:775–787 [W]
  → 确定 newLeafId：
      - 若 targetEntry 是 user message → newLeafId = parentId（以便重编辑）
      - 其他 → newLeafId = targetId
    （[P] 记该 resolve 步骤 agent-harness.ts:781-805；[W] 记 agent-harness.ts:808 起）
  → session.moveTo(newLeafId, summary?)       — session.ts:247 [R]；session/session.ts:115 [P]
      → storage.setLeafId(newLeafId) → 写入 LeafEntry（[W] 记 session.ts:157，types.ts:404–407）
      → 若 summary：追加 BranchSummaryEntry（[W] 记 session.ts:166–173）
  → emitOwn("session_tree")                   — agent-harness.ts:805 [R]；agent-harness.ts:814 [P]；agent-harness.ts:813–819 [W]
```

`BranchSummaryEntry` 字段回顾（`[P]`）：`fromId`（导航来源 entry）、`summary`（生成的摘要文本）、`details?`、`fromHook?`（可选元数据）。

**Forking**（`[W]` 独有的完整描述，与 § 2.4 的 fork 行号呼应）：Fork 创建一个带 entries 子集的新 session 文件；`JsonlSessionRepo.fork()`（`jsonl-repo.ts:119`）打开源 session，调用 `getEntriesToFork()`（`repo-utils.ts:22`）选择 entries，创建新 JSONL 文件并复制 entries；position 为 `"before"`（默认，切在目标 parent 之前）或 `"at"`（含目标 entry）（`repo-utils.ts:26–37`）。

### 2.8 Label Metadata（标签元数据）

- `[R]`（在 § Storage 层描述）：标签缓存 `labelsById` Map，从 `label` entry 增量更新（`jsonl-storage.ts:35`）。
- `[P]`：`Session.appendLabel(targetId, label)`（`session/session.ts:109`）创建一个 `LabelEntry`；标签缓存在两种 storage 实现中都通过 **`buildLabelsById()`** 函数在内存中维护——`session/jsonl-storage.ts:31`、`session/memory-storage.ts:15`（`buildLabelsById` 这一具体函数名仅 `[P]` 点出）。
- `[W]`：`LabelEntry`（`types.ts:393–397`），缓存在 `labelsById` Map（`jsonl-storage.ts:35–41`，`memory-storage.ts:20–26`）。

三方在 `labelsById` 的具体行号上大致相容（`[R]`:35，`[W]`:35–41 起点一致），但 `appendLabel()` 自身的行号（`[P]`: `session.ts:109`）与 `[R]` 记录的 `session.ts:109 = getBranch()`（见 § 2.5）冲突，原样并列。

### 2.9 Pending Writes During Streaming（流式过程中的延迟写入）

`[R]` 描述（归入其"AgentHarness 事件桥接"一节，`agent-harness.ts:157`）：Pending session writes（`agent-harness.ts:464-485`）——在 agent busy 时 deferred 写入，下个 turn 开始前 `flushPendingSessionWrites()` 批量持久化。

`[W]` 给出更细的机制（独立成节）：

- 在一次活跃的 agent turn 期间，session 的写入被**排队**而非立即写入：`pendingSessionWrites: PendingSessionWrite[]`（`agent-harness.ts:168`）。
- `PendingSessionWrite`（`types.ts:493-496`）：所有 entry 类型去掉 `id`/`parentId`/`timestamp` 后的联合类型。
- 会被排队的写入操作（`agent-harness.ts:466-482`）：`appendMessage`、`appendModelChange`、`appendThinkingLevelChange`、`appendActiveToolsChange`、`appendCustomEntry`、`appendCustomMessageEntry`、`appendLabel`、`appendSessionName`、`setLeafId`。
- `flushPendingSessionWrites()`（`agent-harness.ts:462`）在以下时机排空队列：`prepareNextTurn`（两个 turn 之间，`agent-harness.ts:436`）、`message_end`（`agent-harness.ts:491`）、`turn_end`（`agent-harness.ts:502`）、`agent_end`（`agent-harness.ts:508`）、`executeTurn` 结束时（`agent-harness.ts:601`）。
- `turn_end` flush 之后，发出 `save_point` 事件（`agent-harness.ts:504`，与 § 1.5 表格中 `[P]` 给出的 `save_point` 行号一致）。

`[R]` 对具体行为的补充描述（与上面互补，非重复）：`message_end` 时写入 session（`session.appendMessage`）+ 广播给订阅者；`turn_end` 时 flush pending writes + 发 `save_point`；`agent_end` 时 flush pending writes + 设 `phase=idle`。

### 2.10 Metadata Types（元数据类型）

`[P]`/`[W]` 在此处的引用**完全一致**（三份文档中少数几处严格吻合的地方）：

- `SessionMetadata = { id: string, createdAt: string }`（`types.ts:423–426`）。
- `JsonlSessionMetadata` 扩展自 `SessionMetadata`，另加 `cwd`、`path`、`parentSessionPath?`（`types.ts:428–432`）。

补充：

- `[W]`：Session 名称经由 `SessionInfoEntry`（`"session_info"` 类型，`types.ts:399-401`）持久化，通过 `session.getSessionName()`（`session.ts:55-57`）访问——与 `[R]` 记录的 `getSessionName()`（`session.ts:117`，见 § 2.5）行号不一致，原样并列。
- Label 相关的 `LabelEntry`（`types.ts:393-397`）与其缓存位置已在 § 2.8 给出。

---

## 3. Cross-Subsystem Integration（跨子系统交互）

### 3.1 交互示意图（`[R]` 独有）

```
                    Extension Lifecycle                           Session Persistence
                    =================                           ===================

discoverAndLoadExtensions() ───→ loadExtensions() ───→ createExtensionAPI()
 (extensions/loader.ts:651)                  (extensions/loader.ts:521)         (extensions/loader.ts:301)
      │                                │                       │
      ▼                                ▼                       ▼
 discovery(scanner) ──→ jiti import ──→ factory(api) ──→ Extension{handlers, tools, ...}
 (extensions/loader.ts:614)        (extensions/loader.ts:381)    │                   │
                                           │                   ▼
                                           │           ExtensionRunner (runner.ts:282)
                                           │           bindCore() → replace stubs
                                           │                    │
                                           ▼                    ▼
                                   AgentHarness ───→ Session ───→ SessionStorage
                                   (agent-harness:157)  (session.ts:82)  (jsonl/memory)
                                           │                    │
                                           ▼                    ▼
                                     extension emit() ───→ appendEntry()
                                     (runner.ts:766)         (session.ts)
```

### 3.2 Hook × Session 接线表（`[P]` 独有）

`ExtensionRunner` 是 session 事件与扩展 handler 之间的桥梁：

1. `AgentHarness` 为 session 事件（compact、tree 等）调用 `emitHook`/`emitOwn`。
2. 这些调用被 harness 的 `"*"` 订阅者捕获，其中包括 mode 的集成层。
3. mode 的集成层调用 `ExtensionRunner.emit()` / 各个 `emit*()` 专用方法。
4. `ExtensionRunner` 遍历已加载扩展的 handlers，以 `(event, ctx)` 逐一调用。
5. 对于可取消事件（`session_before_*`），第一个返回 `{ cancel: true }` 的结果会短路后续调用。

带"修改能力"的关键 "before" hooks：

| Hook | 扩展可以做什么 | Emitter |
|---|---|---|
| `session_before_compact` | 取消，或提供完整的压缩结果 | `agent-harness.ts:700` → `extensions/runner.ts:628` |
| `session_before_tree` | 取消，或提供 summary | `agent-harness.ts:755` → `extensions/runner.ts:628` |
| `context` | 在 LLM 调用前替换 messages | `agent-harness.ts:409` → `extensions/runner.ts:827` |
| `before_agent_start` | 注入前置消息 / 修改 system prompt | `agent-harness.ts:548` → `extensions/runner.ts:921` |
| `before_provider_request` | 修改 stream 选项 | `agent-harness.ts:251` → `extensions/runner.ts:876` |
| `tool_call` | 阻断工具执行 | `agent-harness.ts:413` → `extensions/runner.ts:802` |
| `tool_result` | 修改工具输出 | `agent-harness.ts:422` → `extensions/runner.ts:772` |

`ExtensionAPI` 还提供直接的 session action 方法：`sendMessage`（发送自定义消息）、`appendEntry`（追加自定义 entry）、`setSessionName`、`setLabel`——均委托给由 `bindCore()` 绑定的 `ExtensionRuntime`。

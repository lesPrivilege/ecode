# Loop 协议 — Code terminal 联调 × Cowork 复盘

2026-07-05。三方分工：**Code session（Opus）** 出 prompt、读 terminal 返回、
直接修小问题、写报告；**人** 在 terminal 执行与把关；**Cowork（Fable）**
验证节点后复盘、裁决、更新契约文档。一轮 = run → fix/log → 验证节点 → 复盘。

## Code session 的「直接改 vs 记报告」分界

**直接改（fix-forward，改完即 commit，一事一 commit）**：
- launcher/脚本的 bug、路径错、变量名错、报错信息不清；
- 文档里与实测不符的**事实性**陈述（如 model 名、file:line 漂移）；
- 判据：不改变任何**设计决定**，改动可被单条 commit message 完整解释。

**只记报告（log-only，不动手）**：
- 涉及设计裁定的（路由策略、参数默认值、协议边界）；
- 跨模块/跨 goal 的改动冲动（哪怕看起来显然）；
- 一切数字结论（节省率、性能）——记原始输出，不下判断；
- 拿不准归哪类的，一律 log-only。

**硬禁区（沿用全项目纪律）**：不碰 `pi/` 上游文件；不动 compaction-core 算法；
不把 key 写进任何文件/报告/commit；G2 packet 内容只读。

## 验证节点（返回 Cowork 复盘的触发条件，满足其一）

1. `launcher-test-checklist.md` 十用例全部有 PASS/FAIL/SKIP 结论；
2. 或 T9（真 key 全链路 + ambient JSONL 落盘）单项通过——最小可复盘单元；
3. 或出现 log-only 级阻塞（设计问题挡住了继续测试）。

## 交接物（复盘的输入，缺一不可）

- `docs/reports/launcher-test-<date>.md`：按清单格式的逐项报告；
- fix-forward commit 列表（`git log --oneline` 区间即可）；
- 未决 log-only 事项清单（每条：现象 → 为什么不是 fix-forward → 建议选项）。

## 复盘产出（Cowork 侧承诺）

- log-only 事项逐条裁决（进 GOALS.md 修订或明确不做）；
- 报告中的实证发现归档（survey 补条目 / 论文素材标记）；
- 下一轮 loop 的目标与验证节点定义。

## 为什么这样分

这个 loop 本身就是论文里的三档位混合体在工作流层的实例：Code session 是
带完整 context 的 in-loop worker（热区），Cowork 复盘是定期的 fresh-eyes
review（隔离审查），验证节点就是切换点——切换变量是「是否出现设计级决策」，
和 D4 的 dispatch policy 同构。用着用着就是在测它。

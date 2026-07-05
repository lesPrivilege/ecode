# G2 首轮执行清单（round 1：R1 / E1 / D1 × 4 臂 = 12 run）

2026-07-05 预制。臂序已随机定死（`shuf` 一次性生成，开跑时不得重排）：

| Packet | 臂序（执行顺序） | workspace 来源 |
| --- | --- | --- |
| G2-R1 | **D → B → C → A** | `snapshots/taucode/`（prepare-snapshot 构建一次，四臂各自复制） |
| G2-E1 | **B → C → A → D** | 空 workspace + 只读 `pi/`（survey Item 7 落法） |
| G2-D1 | **B → C → D → A** | `snapshots/taucode/`（与 R1 同一快照） |

参数：全部 `keep=3` / `compact-after=32k`（推荐参数档；sweep 留 round 2）。

## 开跑顺序

1. credential 注入（`DEEPSEEK_API_KEY` 或 Mimo endpoint → `lib/provider.ts` 配置位）。
2. `prepare-snapshot.ts` 对 `../taucode` 构建一次快照（唯一贵操作，网络 + 分钟级），
   记下 manifestHash。
3. 按上表顺序逐 run 执行；每 run 核对 JSONL 里 `workspace.manifestHash` 与第 2 步一致。
4. 12 run 完成后 `compare.ts` 出三份四臂报告；D1 的导出计数核对人工跑
   （packet 文档里的 Validation 补充脚本）。
   **provider-outage 条款（2026-07-05 补,源自 TUI 验收阻塞)**：
   连接类错误（Connection error / 网络超时）的 run 标记 `provider-error`,
   同臂立即重试一次;仍败则顺延该臂稍后再跑。此类 run **不计入数据、
   不计入 invalid,不计入判定门统计**——环境缺席既非 compaction 未触发,
   也非行为异常;它只说明 provider/key/网络当下不可用。
5. 人工复核表逐份填写；D1 若未复现负区特征（re-read 率显著高于 R1/E1），
   round 2 前先补跑 D2 替代。

## Round 1 要回答的三个问题

1. C 臂在 R1（优势区代表）上是否同时对 A、B 实现总 token ↓ 且质量不劣化？
2. D1（负区探针）是否复现 5-28 负案特征（compacted-path re-read 率显著抬升）？
3. cache 轴（DeepSeek 轮）：C 臂 transition 后 cacheRead 是否恢复稳态
   （预期 90→15→87 形状首次对账）？

三问都有明确答案（含阴性）即 round 1 成功，进入 sweep 与 D4 三臂设计。

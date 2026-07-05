# G2 Round 1 复盘裁决

2026-07-05,Fable。数据:12 run(真 DeepSeek,JSONL meta `provider:deepseek`、
`output_from_usage:true`、manifestHash 全核对)。compare 报告头部
"SYNTHETIC SMOKE FIXTURES" 为 **G1c 时代 compare.ts 硬编码陈旧标头**,
与数据实况不符,记 fix-forward(改 compare.ts:按 meta.provider 打标)。

## 有效性总账(判定门工作正常,这是本轮第一胜利)

| Packet | A | B | C | D |
| --- | --- | --- | --- | --- |
| R1(refactor) | clean | **INVALID** | clean | clean |
| E1(exploration) | clean | **INVALID**+susp | clean | SUSPICIOUS |
| D1(负区探针) | clean | **INVALID** | **INVALID** | **INVALID** |

- **B 臂全线 INVALID——设计缺陷,非执行事故**:pi 原生 compaction 触发点
  在 contextWindow(1M)− reserveTokens(16k)≈ 983k in-context,而所有
  session 的 context 峰值 ~100k,永远够不着。B 从未与 C 同台。
  round 2 修:给原生配可比阈值(压 contextWindow 或改 reserve),否则弃 B。
- **D1 的 C/D 臂 INVALID——探针没扎到**:910 行源文件的 compactable
  content 未过 32k 门,投影零次,负区场景实际没发生。round 2 修:
  加大源文件规模或用 sweep 低阈值臂。
- E1-D 的 SUSPICIOUS(token 降 + 重读微升 +1)待人工质量复核裁定,
  倾向噪声。

## 三问裁定

**Q3(cache transition 曲线)——回答了,这是本轮的实质产出。**
E1-C 逐 turn CH:首次投影 turn 跌至 20-24%,随后 37%→50%,~10 turn 内
恢复至 53-56%(略高于非投影 turn 的 51-52% 稳态)。**预测的
dip-then-recover 形状首次受控观测成立**,确定性投影的 byte-stable
恢复性质经真实 provider 验证。附加发现:E1-D 在 seam-B checkpoint
落点出现 **CH=0 的全清事件**(t10-t12)后恢复——持久化 checkpoint
的 cache 成本比 send-time 投影高一档,量化在案。
投影 turn 的单请求 input 为非投影 turn 的 ~1/3(10-17k vs 30-40k)——
**单请求瘦身是真的**。

**Q1(优势区命题:C 同时赢 A/B)——本轮数据下不成立,但结论受限。**
R1:C 总 input 753k vs A 304k(×2.5),33 turns vs 13;E1:C 2.25M vs
A 1.81M(+24%),56 vs 34 turns。折算 cache 折扣(cached≈0.1×)后
C 仍显著更贵。**主导成本不是 cache break,是 turn 膨胀**——压缩臂
用了远更多的轮次。两种解释待分:(i)压缩致重定向/重复工作(与社区
「13-15% longer trajectories」定性一致,此处更剧烈);(ii)n=1 的
轨迹方差(同任务同模型 turn 数 13/18/33/22,随机性本身巨大)。
**质量复核未做(completion 字段全空)——在人工审 workspace 产物之前,
Q1 不落终判**。

**Q2(D1 负区复现)——未测**(探针未触发,见上)。

## 净省台账(相对成本单位 = uncached + 0.1×cached,n=1,仅记录)

| Packet | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| R1 | 336k | 551k | 833k | 489k |
| E1 | 2,003k | 1,599k | 2,483k | **931k** |
| D1 | 117k | (无效) | (无效) | (无效) |

E1-D(hybrid+checkpoint)以 A 的 46% 成本完成——**全轮唯一强正信号**,
但带 SUSPICIOUS 标记且 n=1,round 2 优先复验。

## Round 2 设计修订(按本轮教训)

1. **重复数**:每臂 n≥3,turn 膨胀是信号还是方差必须靠重复分辨——
   这是最重要的一条;
2. B 臂阈值修复或弃臂;D1 探针加大规模;
3. **completion/质量审计前置进协议**:每 run 结束由执行者记录任务
   产物状态(测试过否/文件在否),不留空白字段;
4. +C' 臂(ECODE_TRUST_PROTOCOL=1);
5. compare.ts 标头修复(fix-forward)。

## 对外可说与不可说

可说:transition 曲线首次受控观测(dip→~10 turn 恢复,含 checkpoint
全清事件)——正是 landscape 核证确认的公开空白,数字可发表。
不可说:任何「省 X%」或「贵 X%」的净省结论——turn 膨胀未定性、
质量未审、n=1。诚实表述:「单请求瘦身成立,单任务总成本在本轮
参数点上未获益,轨迹膨胀是待分解的主导变量」。

## 质量复核补账(2026-07-06,Codex)

**复核边界**:不能做真正的产物盲评。`run.ts` 在写 JSONL 后执行
`rmSync(tempDir)` 清理 workspace;12 个 JSONL 里记录的 workspace 路径
均已不存在,且 JSONL 只保留 metrics/acceptance,不保留文件内容或最终
assistant completion。因此以下只能填「机器可证 completion」与「质量
不可判」,不能伪装成看过产物。

| Packet | Arm | Machine completion | Quality vs A | Gate | Notes |
| --- | --- | --- | --- | --- | --- |
| R1 | A | static 4/4, commands pending | reference not inspectable | clean | workspace purged |
| R1 | B | static 4/4, commands pending | unreviewable | INVALID | native compaction never observed |
| R1 | C | static 4/4, commands pending | **unreviewable** | clean | especially important:33 turns, projected=13, total tokens 776k vs A 317k; static checks passed, but actual split quality/tests cannot be audited because workspace is gone |
| R1 | D | static 4/4, commands pending | unreviewable | clean | workspace purged |
| E1 | A | static 5/5 | reference not inspectable | clean | workspace purged |
| E1 | B | static 0/5 | failed vs A on machine completion | INVALID+SUSPICIOUS | `SUBSYSTEM-MAP.md` absent |
| E1 | C | static 0/5 | failed vs A on machine completion | clean | `SUBSYSTEM-MAP.md` absent despite projected=26 |
| E1 | D | static 5/5 | unreviewable | SUSPICIOUS | static complete, content quality unavailable |
| D1 | A | static 4/4 | reference not inspectable | clean | workspace purged |
| D1 | B | static 4/4 | unreviewable | INVALID | native compaction never observed |
| D1 | C | static 4/4 | unreviewable | INVALID | seam-A threshold never crossed |
| D1 | D | static 4/4 | unreviewable | INVALID | seam-A threshold never crossed |

**Protocol fix before any next run**:必须保留每臂 final workspace 或导出
artifact diff/tarball;否则 quality/completion 永远只能靠 acceptance 代理。
最低成本做法:run 完后复制 allowed outputs + `git diff --stat`/`git diff`
到 `experiments/results/<run>/artifact/`,再清理 tempDir。R1 还需自动执行
pending command checks 或把 command output 另存。

## Round 2 预算裁定(2026-07-06,Codex)

**不批准直接开 n=3 全配置 36 run + sweep。** 原因不是省钱保守,
而是 round 1 暴露出三处会让 36 run 大量失效的前置问题:
B 臂阈值失配导致全线 INVALID;D1 在 32k 下没触发,负区未测到;产物
不留存导致质量复核缺席。直接放大全配置只会把这些无效结构复制三倍。

批准的 round 2 是 **分阶段预算**:

1. **R2-preflight(4-6 run)**:只验证 harness 修复。
   - R1:C 跑 1 次,必须保留 workspace/artifact 并跑 pending commands;
   - B-fixed 跑 1-2 次,证明 native compaction 可触发;
   - D1-low-threshold 或 D1-expanded 跑 C/D 各 1 次,证明负区 compaction
     实际触发;
   - 若任一项失败,停,不进 n=3。

2. **R2-core(n=3,约 27 run)**:只在 preflight 过门后跑 A/C/D 三臂,
   暂不含 B 原臂。
   - Packets:R1/E1/D1;
   - Arms:A/C/D;
   - Repeats:n=3;
   - Total:3 packet × 3 arm × 3 repeat = 27 run。
   - B 只有在 B-fixed 过门后作为 B' 加入;否则不进入主比较。

3. **B' add-on(可选 9 run)**:若 B-fixed 过门,再补
   3 packet × 1 arm × 3 repeat = 9 run,使全四臂比较恢复到 36 run。

4. **Sweep(只跑 C/D,不扫 A/B)**:
   - 先只扫 R1 与 D1 的 C/D,阈值用 4k/16k/32k/64k;
   - 若 core 已包含 32k,额外 sweep = 2 packet × 2 arm × 3 extra thresholds
     = 12 run;
   - D1 必须使用能触发的低阈值/扩容版本,否则 sweep 无意义。

**预算上限裁定**:当前立即批准 4-6 run preflight;条件通过后批准
27 run core;B' 与 12 run sweep 分别作为两道追加门。全量 36+sweep
不是取消,是改成 gate-release,避免把已知无效臂批量复制。

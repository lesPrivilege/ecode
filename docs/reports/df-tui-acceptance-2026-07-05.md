# DF TUI Acceptance Report - 2026-07-05

## Scope

Goal: run one real `./bin/ecode` TUI session through the deterministic compaction lifecycle and capture five narrative screenshots: S-A waiting gate, S-B threshold trigger, S-C CH dip, S-D CH recovery, and S-E `/compact-dash`.

Session command: `./bin/ecode`

Resume id printed on exit: `019f32d6-309d-7472-b9cc-0e586caed0c8`

No API key value was printed or recorded.

## Pre-flight

- `git status --short` at start was not clean. Existing changes were recorded as-is and not handled:
  - Modified: `GOALS.md`
  - Modified: `extensions/deterministic-compaction/src/extension.ts`
  - Modified: `extensions/deterministic-compaction/src/gate-widget.ts`
  - Modified: `extensions/deterministic-compaction/src/observability.ts`
  - Modified: `extensions/deterministic-compaction/src/trust-hint.ts`
  - Modified: deterministic-compaction tests
  - Untracked: `docs/note-release-paths.md`
  - Untracked: `extensions/deterministic-compaction/src/ch-trace.ts`
  - Untracked: `extensions/deterministic-compaction/test/ch-trace.test.ts`
- `DEEPSEEK_API_KEY` was present in shell env, checked only by non-empty status.
- First TUI command was `/compact-status`.
- Default config was confirmed:
  - `compactAfterInputTokens=32,000`
  - `keepRecentAssistantMessages=3`

## Screenshots

### S-A gate waiting

![S-A gate waiting](/private/tmp/ecode-tui-acceptance-2026-07-05/S-A-gate-waiting.png)

This is the successful early-session baseline: `/compact-status` reports `Trigger: waiting`, zero replacements, and `Gate: 32,000 tokens UNDER threshold (0 < 32,000, compactable-content estimate) -> waiting`.

The gate number is the compactable-content estimate, not the footer percentage. The footer `0.0%/1.0M (auto)` is the total context denominator and must not be mixed with the gate denominator.

### S-B threshold trigger

![S-B threshold not reached](/private/tmp/ecode-tui-acceptance-2026-07-05/S-B-threshold-not-reached.png)

Attempted to drive a natural threshold crossing with read-only analysis of `../taucode/packages/core/src/compaction.ts`, `loop.ts`, `context.ts`, `compaction-report.ts`, and `session.ts`. The provider call failed with repeated `Connection error` messages and then `Retry failed after 3 attempts`.

No trigger marker line appeared. No turn number, replacements count, or saved-token figure was produced, so S-B is not satisfied.

### S-C CH dip

![S-C CH dip not observed](/private/tmp/ecode-tui-acceptance-2026-07-05/S-C-ch-dip-not-observed.png)

A smaller probe turn, `ping: please answer ok`, also failed after retries with `Connection error`. The status strip reached `gate 492 / 32,000 compactable · waiting · keep=3`, but `CH` stayed empty.

CH samples require completed assistant response usage. Because no successful assistant response completed after a compaction trigger, no CH dip was observable.

### S-D CH recovery

![S-D CH recovery not observed](/private/tmp/ecode-tui-acceptance-2026-07-05/S-D-ch-recovery-not-observed.png)

S-D requires a prior trigger plus two to three later turns to show recovery. In this session there was no trigger and no usable CH sample stream.

Recovery is therefore a FAIL item rather than a weak pass. No numeric CH trend is inferred.

### S-E /compact-dash

![S-E compact dash](/private/tmp/ecode-tui-acceptance-2026-07-05/S-E-compact-dash.png)

`/compact-dash` returned `Gate: 492 / 32,000 compactable · waiting · keep=3`, `Triggers: none yet`, and `CH: no data`.

This is a useful session-level summary, but it confirms that the lifecycle did not reach compaction. Again, gate uses compactable-content tokens, while the footer `0.1%/1.0M (auto)` is total context.

## Log-only Observations

- The initial worktree was already dirty before this acceptance run.
- `!wc -l ../taucode/packages/core/src/...` worked in the TUI and confirmed target file sizes: `compaction.ts` 910 lines, `loop.ts` 832 lines, `context.ts` 159 lines, `compaction-report.ts` 205 lines, `session.ts` 272 lines. However, `!` bash output did not enter `/compact-status` message/gate accounting, so it cannot serve as S-B evidence.
- Provider requests failed repeatedly with `Connection error`, including a very small `ping` turn. This blocked natural crossing, trigger-marker capture, and CH sampling.
- No code files were edited by this acceptance run.

## Conclusion

Total acceptance result: **FAIL**.

Reason: the five screenshots do not self-explain a completed compaction lifecycle because S-B, S-C, and S-D did not happen in the real TUI session. The only valid story from the evidence is: defaults and waiting gate work; provider connectivity prevented successful assistant turns; `/compact-dash` correctly reports no triggers and no CH data.

---

## Cowork 复盘裁决（2026-07-05,Fable）

**定性改判:environment-blocked,非产品 FAIL。** 执行者按其判据判 FAIL
正确（五图叙事未成立即 FAIL,不美化）;meta 层定性:S-B/C/D 未测而非
被证伪——阻塞源是 DeepSeek 连续 `Connection error`（含最小 ping turn,
排除任务侧原因;此前 T9 与野外 run 同 key 均正常,判定为 provider 侧
瞬态）。产品侧实际拿到两个 PASS:S-A（waiting gate + 双口径标注正确）
与 S-E（dash 在无数据时如实报 none/no data——空态渲染正确本身是
验收项）。

**重试方案**:provider 恢复后只补 S-B/C/D（S-A/S-E 证据沿用,
同 session 语义不变);重试成本 ≈ 一次 read-heavy session。

**两条 log-only 处置**:
1. `!` 前缀 bash 输出不进 gate 计量——符合设计（用户直敲的 bash 不走
   tool_result 通道),但值得在 TUI 文档里写明,防止将来误当 bug 报。
2. 起始 worktree 脏——DF-TUI 实现 + `masterplan` / `upstream-narrative`
   / `essay` / `release-paths` 四份文档 + 本报告仍未 commit,**债务在涨**,
   下个 Code session 开场先做 pathspec 分笔清账。

**G2 协议修订（本次阻塞的直接教训)**:12-run 执行加 provider-outage
条款——连接类错误的 run 标记 `provider-error`,同臂重试一次,仍败则
顺延该臂,**不计入数据也不计入 invalid**（它既不是 compaction 未触发,
也不是行为异常,是环境缺席)。已同步至 run manifest。

**归拢待办**:
1. **重试窗口**:DeepSeek 连通恢复后,Codex 只补 S-B/C/D 三图;S-A/S-E
   沿用,成本一次 read-heavy session。
2. **清账**:下个 Code session 开场先 pathspec 分笔 commit,不要继续把
   DF-TUI 实现、四份叙事/计划文档与本报告攒在同一笔债里。
3. **关键路径不变**:G2 round 1 仍是主线。若连接错误持续,它同时成为
   upstream-narrative 中「cache 边界诊断」旁边的朴素请求素材:provider
   outage 应被标记、重试并排除出判定门统计,不能污染 12-run 结论。

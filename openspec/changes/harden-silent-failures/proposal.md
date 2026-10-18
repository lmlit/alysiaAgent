# Change Proposal: harden-silent-failures

## 元信息

- **日期**: 2026-10-18
- **类型**: FIX（消灭"失败被降级为没发生"的残余）
- **状态**: proposed
- **影响 spec**: `memory-system`（§4.7 写入留痕 / §4.1.1 LLM 输出判据）、`qq-reconnect-backoff`（适配器侧留痕）
- **前置**: `observe-zero-row-writes`（已落地，提供观测）、`fix-store-write-trace`（已归档，已修 5 条）

## 范围：本 change **只收无主的三件**

静默失败族共 6 条还开着，其中 **3 条已有各自的 change**，本 change 不重复接管：

| 条目 | 归属 | 本 change 做什么 |
|---|---|---|
| KI-11 写入判据 | `tune-zero-row-checks`（等数据） | 不碰 |
| KI-1 / KI-2 预算 | `decide-life-event-max-tokens`（等数据） | 不碰 |
| **KI-5 残余裸 catch** | **无主** | ✅ 收 |
| **KI-26 摘要永不可达** | **无主** | ✅ 收 |
| **KI-25 去重键取证** | **无主** | ✅ 收（只取证 + 加判据，**不换键**） |

根因分析与修复顺序见 [`docs/SILENT-FAILURE.md`](../../../docs/SILENT-FAILURE.md)；
在办总表见 [`docs/TODO.md`](../../../docs/TODO.md)。

## 动机（为什么做）

族内 14 条已修的共同模式是「**错误要么抛、要么有带 tag 的留痕**」。
剩下的三件正好卡在三个不同层（提取器 / 摘要锚点 / 跨进程去重），
如果只修已开 change 的那两条，**这个族会留成"修了一半"的状态** ——
而半修的状态比不修更危险：它让人以为这个模式已经清干净了。

具体三处现状：

1. **KI-5**：全仓仅剩 **4 处**裸 `catch {}`，全在非存储层：
   `packages/core/src/memory/engines/ProfileExtractor.ts:150`、
   `packages/core/src/memory/processors/CronProcessor.ts:81`、
   `packages/server/src/adapters/qq-official.ts:267`、`:286`。
2. **KI-26**：`summaryAnchor()` 在「无历史摘要」时回落到 24h 前，
   于是一批本来就早于 24h 的消息**没有锚点可达** ⇒ 永远不进摘要。
3. **KI-25**：去重键 `dsh-${sid}-${event.seq}`（`packages/dsh-adapter/src/index.ts:379`），
   其正确性依赖「`seq` 跨重启/重传稳定」这一**从未验证**的前提。

## 需求（做什么）

- [ ] KI-5：逐点判定 4 处裸 catch 的正确处理（rethrow / warn + 计数 / 明确豁免），
      **不允许"加一句 log 就算修"**（判据见 SILENT-FAILURE §7）
- [ ] KI-26：摘要锚点加兜底（无摘要时不设 24h 下限或显式取最早已处理点），
      **并打一条 warn 说明命中了兜底**
- [ ] KI-25：加一次性取证日志（`sessionId` + `seq` + 是否首次见），
      跑满一次 dsh 重启后按数据判定；**本 change 不换去重键**
- [ ] 新增 `scripts/check-bare-catch.cjs`（`catch {}` 命中即 exit 1），接进 pre-commit

## 设计决策

- **为什么 KI-25 只取证不改键**：`SessionEvent.id` 可能比 `seq` 更稳，
  但"可能"不是证据。换键是改跨进程契约，需要独立 change；
  在没有"seq 会重数"的实测前换掉，等于用猜测替换另一个猜测。
- **为什么把检查脚本放进本 change**：验收标准 §6.1 是"可机器判定"，
  不放脚本它就只是文案；且 pre-commit 已有位置（`scripts/git-hooks/pre-commit`）。
- **为什么不动 KI-11 / KI-1**：它们各自有 change 在等数据。
  合并会让本 change 也变成"等数据"，把三件**今天就能做完**的事拖住。

## 对账方向确认

- [ ] 与 `memory-system` §4.7「存储写入留痕」不冲突：本 change 只补**非存储层**的留痕
- [ ] `case` 涉及 Web API？否（无新增 endpoint、无 core 公开方法变更）
- [ ] 涉及 `docs/Web-API-Design.md`？否

## 测试计划

1. 单测：4 处裸 catch 各一条"错误路径必须留痕/必须抛"的用例（现状是**无断言**）。
2. 单测：构造「无历史摘要 + 消息全部早于 24h」会话，断言它能被摘要（KI-26 复现用例，
   `cron.test.ts` / `real-api.test.ts` 已各挂 1 条同形用例可复用）。
3. 真机：dsh 重启一次，读出 `seq` 是否重数，把结论写回 KI-25。
4. 检查脚本：故意留一处 `catch {}`，确认 `node scripts/check-bare-catch.cjs` exit 1。

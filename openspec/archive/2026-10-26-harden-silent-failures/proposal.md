# Change Proposal: harden-silent-failures

## 元信息

- **日期**: 2026-10-18（**2026-10-26 范围收缩**，见下）
- **类型**: FIX（消灭"失败被降级为没发生"的残余）
- **状态**: applied（2026-10-26 实现，待归档）
- **影响 spec**: `server-hardening` §8（**2026-10-26 新增**：网关帧解析不得静默丢弃）
- **前置**: `fix-store-write-trace`（已归档）、`fix-summary-anchor-floor`（已归档）

## ★ 2026-10-26 范围收缩（原立项说三件，实际只剩一件）

立项时本 change 打算收 KI-5 / KI-26 / KI-25 三件。逐个核对后：

| 原计划 | 2026-10-26 核对结果 | 处置 |
|---|---|---|
| **KI-26** 摘要永不可达 | **已修**：`fix-summary-anchor-floor`（2026-10-16 归档），无摘要时下界改为「最早事件 −1ms」，真实 e2e 转绿 | **移出**，不算本 change 的账 |
| **KI-25** dsh 去重键取证 | 前提仍未证实，但 `alysia-adapter.config.bridge: false`（2026-10-24）后 **ingest 已关，触发路径休眠** | **移出**：不再阻塞本 change；改登记在 `docs/TODO.md`，等重开前取证 |
| **KI-5** 裸 `catch {}` | 原写 4 处，实测 **2 处**（`ProfileExtractor` / `CronProcessor` 已改 warn + 返回失败状态） | **本 change 只做这 2 处**（都在 QQ 适配器） |

⇒ 本 change 的交付 = **QQ 网关帧解析的 2 处裸 catch + 机器闸**。

## 问题

`packages/server/src/adapters/qq-official.ts` 的帧载荷解析有两处裸 `catch {}`
（握手尾随帧、正常帧）。后果不是崩溃，而是**静默丢帧**：

- 网关改字段 / 发出半截 JSON / 某类事件结构变化 ⇒ 整帧被丢掉；
- 症状是「Bot 在线，但某些消息永不触发」，日志里**零行**可查；
- 与 KI-5 同族：错误被降级成"没有发生"（`docs/SILENT-FAILURE.md` §2）。

## 需求（做什么）

- [x] 两处裸 catch 收敛为一个 `handleFramePayload(raw, stage)`：
      坏帧**不抛**（不断连接）、**warn**（阶段 + 字节数 + 累计次数 + 原因）、**限频**（前 3 次逐条，之后每 100 次一条）
- [x] 新增 `scripts/check-bare-catch.cjs`：真·空 catch（块内既无代码也无注释）⇒ exit 1；
      注释说明过的 best-effort **不拦**（否则仓里 19 处有说明的降级会全部误报）
- [x] 接进 `scripts/git-hooks/pre-commit`（第 ④ 段）
- [x] spec：`server-hardening` 新增 §8 四条契约
- [x] 测试：`qq-official.test.ts` 新增 2 条（非法 JSON 不抛且 warn；连续坏帧前 3 次逐条）

## 设计决策

- **为什么坏帧不抛**：一帧坏不等于连接坏；抛出会打断 socket，把"丢一帧"升级成"断整条连接"。
- **为什么限频**：坏流持续时逐帧 warn 会刷屏，把真信号埋掉；计数仍在累加，日志能看出"已经 N 次"。
- **为什么闸只拦真·空 catch**：`catch { /* 为什么可以忽略 */ }` 是有意的降级，
  它和裸 catch 的区别正是"有没有给出理由"。闸拦的是"没有任何交代"。
- **为什么不换 KI-25 的去重键**：`seq` 语义未证实；换键是改跨进程契约，需独立 change + 实测。

## 对账方向确认

- [x] 不涉及 Web API / core 公开方法（无新增 endpoint）
- [x] spec 方向：`server-hardening` §8 是**新增契约**（impl 已按此实现），不是降级迁就现状

## 测试计划

1. 单测：`packages/server/tests/qq-official.test.ts`（11 条，含新增 2 条）。
2. 机器闸自检：故意留一处真·空 `catch {}` ⇒ `node scripts/check-bare-catch.cjs` exit 1；
   当前仓库 exit 0。
3. 全量：Node 24 全绿（数字见 tasks.md）。

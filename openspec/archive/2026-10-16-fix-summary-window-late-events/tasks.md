# Tasks: fix-summary-window-late-events

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 纪律：虚构事件与合成数据；不联网、不外传；未执行的测试不标为通过。

## 实现任务

- [x] T1 复现测试：cron 先摘要 → 迟到事件永久落不进窗口（**先确认是红的**，见下）
- [x] T2 `SessionEndProcessor.process()` 的 `ended_at` 改为
      `min(窗口内最新事件 created_at, now)`，并写清字段语义注释
- [x] T3 测试 W2（`ended_at` === 最新事件时间）/ W3（不晚于处理时刻）/ W4（锚点不回退）
      + 幂等用例
- [x] T4 既有 6 条窗口用例（`message_count` / `started_at`）继续通过
- [x] T5 **D4/R6**：`EventStore.getBySession` 的 `since` 改开区间（`>`），
      同步更新 `event-window.test.ts` 两处边界断言 + 新增显式 `(since, until]` 用例
- [x] T6 更新 `openspec/specs/memory-system/spec.md` §5.4.1：新增契约 4 / 4b
      + 记录被否决的替代方案
- [x] T7 **连带修正** `openspec/specs/dsh-adapter/spec.md` §2.5.1 契约 5 的理由段
      （原文「`ended_at` = 服务端当时时间 ⇒ 永久摘不到」的前提已被本 change 修掉）
- [x] T8 **记录但不修**：`conv.id` 同毫秒主键冲突（→ `docs/KNOWN-ISSUES.md` KI-19 补记）

## Apply 任务

- [x] A.1 合并 `spec.md` 到 `openspec/specs/memory-system/spec.md`（**清掉 diff 标记**，已验零命中）
- [x] A.2 更新 `openspec/specs/index.md`（memory-system 行「最后变更」）
- [x] A.3 运行 `packages/core` 全套（Node 24，排除 e2e）——命令与结果见下
- [x] A.4 记录部署状态（见下）

---

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| core | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run --exclude='tests/memory/e2e/*'`（`packages/core`） | **67 files / 660 passed**（改动前基线 654，本 change +6） |
| core（定向） | 同上前接 `tests/memory/session-end-window.test.ts` | 11 passed |
| core（定向） | 同上接 `tests/memory/event-window.test.ts` | 13 passed |

**红→绿证据**（改实现**之前**先跑新测试，`tests/memory/session-end-window.test.ts`）：

```
× ★★ 主症：cron 先摘要后，迟到事件仍必须被下一次摘要覆盖
    AssertionError: 迟到事件被摘要窗口越过了 —— 它永久进不了摘要: expected 1 to be 2
× ★ ended_at 取**数据边界**（窗口内最新事件的时间），不是墙钟
    expected '2026-10-16T12:57:44.688Z' to be '2026-10-16T12:27:44.687Z'
× ★ 锚点单调不回退：窗口右边界必然是窗口内最新事件（≥ 下界）
× ★ 幂等：同一批数据重跑摘要不会跳过任何东西
    → SqliteError: UNIQUE constraint failed: conversations.id   ← 见「顺带发现」
```

主症那条的 `expected 1 to be 2` 就是缺陷本身：**第二轮摘要行根本没有诞生**，
那些事件落进了 `created_at >= anchor` 的窗口之外。

**D4 落地时暴露的连带改动**（`since` 闭区间 → 开区间）：
`event-window.test.ts` 有 2 条断言**显式锁着旧语义**，按新契约更新：

```
- expect(withUntil).toHaveLength(11);  expect(withUntil[0].id).toBe('e-100')
+ expect(withUntil).toHaveLength(10);  expect(withUntil[0].id).toBe('e-101')
- expect(got.length).toBe(21);  expect(got[0].id).toBe('e-1415')
+ expect(got.length).toBe(20);  expect(got[0].id).toBe('e-1416')
```

## 顺带发现（**未修**，已登记）

`SessionEndProcessor` 的主键是 `conv-${sessionId}-${Date.now()}` ⇒
**同一毫秒内对同一会话跑两次 `process()`** 会 `UNIQUE constraint failed: conversations.id`，
`onSessionEnd` 捕获后 rethrow ⇒ **后一条摘要整条丢失**。
它是 KI-19（同一会话可能被重复摘要）的**加重后果**，与窗口右边界无关，
按「一个 change 只做一件事」**不在本 change 修**，已补记进 `docs/KNOWN-ISSUES.md` 的 KI-19。

## 部署状态

**未部署。** 本轮只做代码与契约，未构建镜像、未重启服务、未碰线上数据。

**⚠️ 部署时的验证口径**（§5.4.1 契约 4）：部署后新摘要行的
`ended_at` 应当**不再等于处理时刻**，而等于该窗口最后一条事件的 `created_at`；
`ended_at - started_at` 仍在 24h 内。可用现成脚本 `packages/server/scripts/verify-window-fix.ts`
按同样口径抽查。

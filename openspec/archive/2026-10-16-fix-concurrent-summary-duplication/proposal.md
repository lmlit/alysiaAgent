# Change Proposal: fix-concurrent-summary-duplication

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（并发正确性；**含一次"修法必须两件一起"的判断**）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `memory-system` §5.4.1 **新增契约 4d**
- **来源**: `docs/KNOWN-ISSUES.md` **KI-19** 的残余（原症状"同一会话 20 秒内两条 conversation"）

## 这条要解决什么

同一会话被**重叠结算**时的两种坏结果，同一个根因：

1. **id 撞车**：`conversations.id = conv-${sessionId}-${Date.now()}`
   ⇒ 同一毫秒的两次落库做出**同一个 id** ⇒ `INSERT` 撞 PRIMARY KEY
   ⇒ `UNIQUE constraint failed: conversations.id` ⇒ 异常抛给调用方
   ⇒ **后一次整段丢失**。
2. **重复摘要**：两次调用**重叠**时（各自在对方落库前就算好窗口锚点），
   两次都摘**同一批事件** ⇒ 同一会话**两条摘要**。

## ★★ 关键判断：**不能只把 id 改成唯一**

撞 PK 其实**歪打正着地挡住**了问题 2。
所以"只把 id 改成唯一"会把「**崩溃 + 丢一条**」换成「**静默重复两条**」——
**拿一个更响的错换一个更坏的静默错**。

⇒ 正确修法是**两件一起，且顺序不能反**：

| | 角色 |
|---|---|
| **per-session 并发互斥**（`inFlight` 集合） | **语义修复** —— 同一会话同时只允许一个摘要在跑 |
| **id 唯一**（`randomUUID()` 短后缀） | **防御** —— 即便互斥失效，也不该撞 PK 把整段丢掉 |

锚点（`getLatestBySession` 的 `ended_at`）**挡不住重叠**：它只在**第一次落库之后**才前进。

## 需求（做什么）

- [ ] **R1**：`SessionEndProcessor.process()` 加 per-session 互斥；
      命中时 `{ summarized: false, reason: 'in-flight' }` + **限频留痕**
- [ ] **R2**：`conversations.id` 加唯一后缀（保留时间戳便于排查）
- [ ] **R3**：**重试路径不受影响** —— `retryFailedSummaries` 那时第一次早已结束、不在飞
- [ ] **R4**：互斥必须**释放**（`finally`），异常也不能把会话永久锁死

## 测试计划

`packages/core/tests/memory/concurrent-summary.test.ts`（新，3 例）：

| 编号 | 场景 | 验收 |
|---|---|---|
| S1 | **主症**：`Promise.all([onSessionEnd, onSessionEnd])`，冻结 `Date.now` | **不抛**且**只有 1 条** conversation |
| S2 | 守卫：顺序两次 `onSessionEnd` | 第二次走 `no-events`，仍 1 条（锚点会前进） |
| S3 | 守卫：两条**不同**会话并发（同一毫秒） | 各自成行，id 不撞 |

⚠️ **测试必须走 `MemoryManager`**，不能直接调 `SessionEndProcessor.process(sid)` ——
后者**不传 `since`** 会落回"缺省全历史"语义（正是 `fix-session-end-window` 修过的坑）。
**我第一版就这么踩了**：测出来的"重复摘要"其实是测试自己绕过了锚点。
走 `MemoryManager` 之后，S1 复现的是**真的** PK 崩溃（见 tasks.md 的原文）。

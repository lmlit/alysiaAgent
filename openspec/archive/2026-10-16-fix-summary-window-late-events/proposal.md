# Change Proposal: fix-summary-window-late-events

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（修 bug，含一处字段语义澄清）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署，见 tasks.md 末尾）
- **影响 spec**: `memory-system` §5.4.1（新增窗口右边界契约）、`dsh-adapter` §2.5.1（**修正契约 5 的理由段**）
- **来源**: 修复计划「第一批」第 2 项的后半句 ——
  「**检查 cron 是否仍可能在迟到消息入库前推进摘要窗口；若成立，单独补服务端防护**」。
  上一个 change（[`fix-dsh-ingest-and-settlement`](../2026-10-16-fix-dsh-ingest-and-settlement/proposal.md)）
  只消除了**适配器侧**的抢跑，本 change 补**服务端侧**这一条独立时序。

## 动机（为什么做）

### 已坐实的机制（读代码，不是推测）

三个事实拼起来就是永久丢失：

1. `archiveStaleSessions()`（cron 每 6h，`packages/server/src/modules/cron.ts`）挑选
   **24h 内有过事件**的会话（`EventStore.getActiveSessions(since)`），
   对每个会话取锚点 `summaryAnchor(sid)` 后调 `SessionEndProcessor.process(sid, anchor)`
   （`MemoryManager.ts:1089-1132`）。
2. `process()` 的窗口**只有下界**：`getSessionEvents(sid, since)` →
   `EventStore.getBySession(sid, { since })`，没有上界；
   落库时写 **`ended_at = now`（服务端当时时间）**（`SessionEndProcessor.ts:139-149`）。
3. 下一次的锚点 = `ConversationStore.getLatestBySession(sid).ended_at`
   （`MemoryManager.ts:1063-1070`，即 spec §5.4.1 契约 1）。

⇒ 只要有一条事件在**这次摘要之后**才入库，而它的 `created_at`（**来源系统的事件时间**，
dsh 侧取自 `event.time`）**早于**那条摘要的 `ended_at`（服务端墙钟），
它下一次就落进 `created_at >= anchor` 的**窗口之外**，**永远不会被摘要**。
且这条摘要的 `summary_status='ok'`，`retryFailedSummaries()` **不会补**。

### 为什么这在 dsh 侧**仍然可达**（前一个 change 没堵住）

前一个 change 让 `session/disposed` 的结算**等消息确认落库**（适配器侧）。
但 cron 是**同一个进程里的定时器**，它**不经过适配器**：

- dsh 的 `pending` 队列**只在 `turn/end` / `session/disposed` 才 flush**。
  一个长 turn（多步工具调用）可以持续数分钟到数十分钟，这期间消息**一直在队列里**。
- 该会话因为**上一轮**的事件已入库，所以它算「24h 内活跃」→ **cron 会处理它**。
- cron 恰好在这个窗口内跑（每 6h 一次）→ 摘要把右边界推到墙钟 `now`，
  紧接着 `turn/end` 把在途消息送进来 → 这批消息**永久进不了摘要**。

⇒ 不需要服务端宕机（服务端宕机时 cron 也不跑），只需要
**「一个跨 cron tick 的长 turn」**，概率不高但后果**永久且静默**。

### 同一机制对非 dsh 来源也成立

任何「事件入库晚于其 `created_at`」的路径都一样（QQ 重连补发、Web 端批量导入）。
所以修在**窗口规则**上，而不是给 dsh 打特例。

## 需求（做什么）

- [ ] **R1**：摘要窗口的右边界必须由**数据**决定，不由墙钟决定 ——
      `ended_at` 取「本次窗口内**最新一条事件的 `created_at`**」
- [ ] **R2**：`ended_at` **不得晚于**处理时刻（防未来时间戳把后续事件挡在窗口外 ⇒ 丢数据）
- [ ] **R3**：锚点单调不回退（窗口下界不得因本改动后退，否则重复摘要）
- [ ] **R4**：不改变既有四个入口的锚点规则（§5.4.1 契约 1/2 不变）
- [ ] **R5**：契约写进 spec §5.4.1；并**修正** `dsh-adapter` §2.5.1 契约 5 里
      「迟到事件早于 `ended_at`」那段**理由**（它描述的是修复前的世界）
- [ ] **R6**：窗口改为半开区间 **`(since, until]`** —— 否则 R1 会引入
      「边界事件被相邻两次摘要各摘一遍」的新缺陷（见 D4）

## 设计决策（怎么做，含备选与取舍）

### D1 改 `ended_at` 的取值：`min(窗口内最新事件 created_at, now)`

一行改动（`SessionEndProcessor.process()` 里 `ended_at: now` → 数据边界），
但它把窗口从**墙钟驱动**变成**数据驱动**，于是：

- 已入库事件是会话流的**前缀**（dsh 侧因 FIFO 一定成立）⇒
  迟到事件的 `created_at` **必然晚于**「已摘要的最新事件」⇒ 一定落在下一窗口内。
- 顺带得到**幂等性**：对同一批数据重跑摘要不会跳过任何东西。

**被否决：让 cron 跳过 `dsh:` 会话。** 会丢掉 cron 本来要兜的场景 ——
dsh 崩溃/被杀、`session/disposed` 从没发生过的会话将**永不摘要**（正是 8-09
「短对话永不归档」那个洞）。而且治不了 QQ / Web 端的同源问题。

**被否决：给窗口加「最近 N 分钟不摘」的宽限期。** 治不了：问题不是「太近了」，
而是**锚点越过了尚未入库的数据**——宽限期一过，同一丢失照样发生。

**被否决：让适配器上报「水位」（已 flush 到哪个 seq）。** 要动 `/api/ingest` 契约、
服务端要持久化水位、还要定义水位缺失时的行为；复杂度远超收益，且只治 dsh 一家。

### D2 `ended_at` 的语义澄清（写进契约，避免下一个人误解）

字段名容易被读成「摘要生成时刻」。本 change 明确它的语义是
**「本次窗口覆盖到的最后一刻（数据边界）」**——
`started_at` 已经是「窗口内最早事件的时间」（同一套口径），
`ended_at` 不过是对称的另一端。墙钟时刻从来不参与锚点计算，
用数据边界反而让 §5.4.1 的锚点规则**自洽**。

### D3 不改 `started_at`、不改锚点 helper、不改四个入口

本 change 只动「窗口右边界怎么取」，其余一律不碰 —— 这样风险面最小，
且 §5.4.1 契约 1/2 的既有验收（`message_count` / `started_at`）继续成立。

### D4 顺带必须改：窗口收成半开区间 `(since, until]`（**修订既有契约**）

**这是 D1 的正确性组成部分，不是夹带。** 锚点现在是**某条事件的 `created_at`**
（它就是这个会话里最后一条被摘要的事件），而 `getBySession` 的 `since` 是**闭区间**
（`created_at >= ?`）⇒ **边界那条事件会被相邻两次摘要各摘一遍**
（重复计数、重复画像提取）。**这是 D1 自己引入的回归**，必须一并修掉。

做法：`since` 改 `>`，`until` 保持 `<=`。收益是得到一个一致的**游标**语义 ——
`since` = 最后一条**已**处理的事件，下一窗口从它**之后**开始。
该语义对两个调用点（`process()` 的实时窗口、`retryFailedSummary()` 的历史回填）都对：
回填窗口 `(上条摘要终点, 失败窗口终点]` 既不重摘边界、也不漏失败窗口的最后一条。

> ⚠️ **披露**：这条**修订了一个被测试显式锁住的既有契约**。
> 9-26 的 `event-window.test.ts` 写着「边界语义是 `>=`（**包含** anchor 那一条本身）……
> 本 change 不顺手改成 `>`，那是另一个语义决策，会改变摘要窗口边界」——
> 那次**刻意推迟**了它。本 change 兑现，并同步改两处边界断言
> （核心回归 21→20 条、回填窗口 11→10 条）+ 新增一条显式 `(since, until]` 用例。

### D5 不修：本次测试顺带发现的 `conv.id` 同毫秒冲突（**记录，不在本 change 修**）

排查 D1 时，幂等用例一度报 `UNIQUE constraint failed: conversations.id`：
`SessionEndProcessor` 的主键是 `conv-${sessionId}-${Date.now()}` ——
**同一毫秒内对同一会话跑两次 `process()` 会主键冲突**，后一条整条丢失
（`onSessionEnd` 捕获后 rethrow）。
它属 **KI-19**（「同一会话可能被重复摘要」，已登记的并发触发方场景）的**加重后果**，
与窗口右边界无关。按「一个 change 只做一件事」的纪律**不在本 change 修**，
只把发现补记进 `docs/KNOWN-ISSUES.md` 的 KI-19。
（D4 落地后本 change 的用例不再触发它 —— 第二次窗口为空、根本不落行。）

## 对账方向确认

- [x] 与现有 spec 是否冲突？——**补契约**。§5.4.1 只声明了「窗口**下界**（锚点）只有一处定义」，
      **从未声明上界**；实现里上界是隐含的墙钟 `now`。本 change 把上界显式化为契约。
- [x] 方向判断：`docs/KNOWN-ISSUES.md` 无对应 KI（这是计划新查出来的），
      故**新建**契约而非 ratify drift。**不**把任何既有 doc 降级。
- [x] 涉及 Web API？——**不新增/不修改任何端点**。`ended_at` 出现在会话摘要的返回数据里，
      值会从「墙钟」变成「数据边界」（通常只差几秒到几十分钟），
      `docs/Web-API-Design.md` 的字段清单/类型不变，无需改；若其描述了语义则同步一句。
- [x] **连带修正**：`dsh-adapter` §2.5.1 契约 5 的理由段写着
      「新落库摘要行的 `ended_at` = **服务端当时时间**」——本 change 后这句不再成立，
      必须一起改（否则两份 spec 互相矛盾）。

## 测试计划

**纪律**（计划 §八）：虚构事件、合成数据；不联网、不外传；未执行的测试不标为通过。
落点：`packages/core/tests/memory/session-end-window.test.ts`（现有夹具已能精确控制 `ended_at`）。

| 编号 | 复现的旧问题 | 验收 |
|---|---|---|
| W1 | **主症**：cron 先摘要 → 迟到事件（`created_at` 更早）永久落不进窗口 | 第二轮摘要**必须**覆盖迟到事件（旧行为：窗口内 0 条 → 不落行 → 永久丢失） |
| W2 | 右边界取的是墙钟而不是数据 | 首条摘要的 `ended_at` === 窗口内最新事件的 `created_at` |
| W3 | 未来时间戳会把后续事件挡在窗口外 | `ended_at` 不晚于「处理时刻」 |
| W4 | 锚点不得后退（防重复摘要） | 新摘要 `ended_at` >= 上一条 `ended_at` |
| W5 | 既有验收不得回归 | §5.4.1 那 6 条既有窗口用例继续通过（`message_count` / `started_at`） |

**回归**：`packages/core` 全套（Node 24，排除 e2e）。

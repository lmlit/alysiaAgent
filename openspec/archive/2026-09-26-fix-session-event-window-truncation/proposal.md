# Change Proposal: fix-session-event-window-truncation

## 元信息

- **日期**: 2026-09-26
- **类型**: FIX
- **状态**: archived（2026-09-26 实现+端到端验证完成）
- **影响 spec**: `memory-system`（§2.1 Event Log 查询语义 / §3.1 三层处理时机）
- **发现来源**: 2026-09-26 部署后的**生产验证**（cron 跑 3 次、0 条摘要，日志却报 `archived 1/1`）
- **前置**: `fix-session-summary-silent-failure`（已归档）——本 change 修的是**另一个**独立缺陷

## 动机（为什么做）

### 现象

9-26 部署新版后容器跑了 18 小时，cron 正常跑了 3 次（06:48 / 12:48 / 18:48），
每次都报 `[Memory] archived 1/1 sessions`，**但库里 0 条新摘要**。

### 根因：事件窗口被"最旧 1000 条"截断

```ts
// packages/core/src/memory/stores/EventStore.ts:69-76
getBySession(sessionId: string, limit?: number): MemoryEvent[] {
  const query = limit
    ? 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    : 'SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC LIMIT 1000';
```

**`ASC` + `LIMIT` = 只返回最旧的 N 条**，而调用方要的是"最近的会话内容"。

实测（线上权威库，主会话已积累 1436 条事件）：

```
该会话事件总数:                            1436
getBySession 返回:                         最旧的 1000 条（最晚到 2026-09-03T01:26）
anchor（上条摘要 ended_at）:                2026-09-24T16:11
结果中落在 anchor 之后的:                    0 条   ← 关键
⇒ messageEvents.length === 0 → process() 直接 return
```

### ★ 这条推翻了上一轮的归因

`fix-session-summary-silent-failure` 的 proposal 把"最后一次真摘要是 9-03"
归因于 8-28（`character_perspective` 字段）+ 9-01 部署。**那个归因不完整**：

| 事实 | 值 |
|---|---|
| 该会话第 1000 条事件的时间 | **2026-09-03T01:26** |
| 最后一条真摘要的 ended_at | **2026-09-03T03:45**（跨过 1000 条之后 2 小时） |

**9-03 是"事件数撞上 1000 上限"的日子**，不是（只是）字段改动的日子。
两个缺陷叠加：**B 让管道空转，A 让万一跑到 LLM 的那些也失败**。
A 已修且独立验证（真实 API 3/3 → 0/3），但 **B 不修，A 救不回生产**。

### 为什么这个 bug 特别难发现

`archiveStaleSessions` 的 `archived++` 是**无条件**的：

```ts
await this.sessionEndProcessor.process(sid, anchor);
archived++;   // ← process() 提前 return 了也照样 +1
```

所以日志报"archived 1/1"，**看起来像归档成功**，实际什么都没做。
这是"日志写了但没变成信号"的又一个实例（与上一个 change 的 `summary LLM failed`
被淹没是同一类问题）。

## 需求（做什么）

### A. 修正查询语义（核心）

- [ ] `EventStore.getBySession(sessionId, opts?)` 改为「取**最近** N 条、可按时间窗过滤、
      返回时按时间正序」：
      ```sql
      SELECT * FROM (SELECT * FROM events WHERE session_id = ?
                     [AND created_at >= ?] ORDER BY created_at DESC LIMIT ?)
      ORDER BY created_at ASC
      ```
- [ ] `SessionEndProcessor.getSessionEvents(sessionId, since)` 把 `since` 透传到 SQL
      （`process(sessionId, since)` 本来就有 `since`，只是没往下传）
- [ ] 无 `since` 时取最近 N 条（而非最旧 N 条）——长会话的"全量"摘要也应覆盖**近期**内容

### B. 让"空转"不再伪装成成功

- [ ] `process()` 返回结果（如 `{ summarized: boolean; reason?: string }`）而不是 `void`
- [ ] `archiveStaleSessions` 只在**真的产生了摘要**时 `archived++`，
      空转单独计数并记日志（如 `skipped N（无新事件）`）
- [ ] 保留 `dialogue.length === 0` 的显式日志（上一 change 已加）

## 设计决策（怎么做，含备选与取舍）

**决策 1：改查询语义，而不是简单把 1000 调大**

改大只是推迟问题（会话是"永不结束"的，早晚再撞上）。而且真正的问题是**取错了那一端**：
要的是最近的内容，代码取的是最旧的。

**决策 2：加 `since` 参数走 SQL 过滤，而不是取回来再在内存里 filter**

当前实现是「取 1000 条 → 内存里 filter by since」。这意味着**能不能取到窗口内的数据，
取决于窗口外有多老**——正是本次故障。过滤下推到 SQL 后，窗口多大都不受影响。

**决策 3：保留 LIMIT（不给无限查询）**

会话可以无限长，必须有上限兜底。但语义改为"最近的 N 条"，并且在截断时**记日志**
（截断了多少），符合"不静默"的约定。

**决策 4：`process()` 返回结果**

这是 B 部分的根据。其他调用方（`onSessionEnd` / `extractProfile`）也可据此如实回报，
而不是像现在 `extractProfile` 那样只能靠读库猜（上一 change 修过一次同款问题）。

## 对账方向确认

- [x] 与现有 spec 冲突？**spec 未描述该方法的查询语义**（§2.1 只讲表结构）
      → 本 change 为**新增描述**，不改既有内容
- [x] 上一 change 的 proposal 归因需**更正**？——属于**已归档文档**，
      按规矩**不改写归档**；本 change 在自己的 proposal 里写清更正（已在上方"★ 这条推翻了上一轮的归因"）
- [x] 涉及 Web API？`getBySession` 是内部方法，**不新增/不修改 `/api/*` 契约**
      （`extractProfile` 返回值语义不变，仍返回 `summaryGenerated`）

## 测试计划

- [ ] **核心回归**：1436 条事件、anchor 在最后 20 条之前 → **必须能取到那 20 条**
      （当前实现取到 0 条，即本 change 的靶子）
- [ ] 超过 LIMIT：`since` 窗口内 > N 条 → 取最近的 N 条（不是最旧的）
- [ ] 无 `since`：取最近 N 条（不是最旧的），且按时间正序返回
- [ ] `since` 早于所有事件 → 等价于"全量"
- [ ] `since` 晚于所有事件 → 空数组
- [ ] 返回值按 `created_at` **升序**（对话拼接依赖顺序）
- [ ] `process()` 空转时返回 `summarized: false` + 原因
- [ ] `archiveStaleSessions` 空转时**不**计入 `archived`
- [ ] **端到端**：构造一个 >1000 事件的会话，跑一次 cron，断言真的产生了新摘要

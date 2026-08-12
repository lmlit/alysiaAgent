# Change Proposal: reminder-sqlite-persistence

## 元信息

- **日期**: 2026-08-12
- **类型**: FEATURE（提醒持久化，容器重启不丢失）
- **状态**: pending
- **影响 spec**: reminder-tool（reliability → persistence）

## 动机（为什么做）

Reminder 工具纯内存存储（`const reminders: Reminder[] = []`，reminder.ts:4
注释"重启丢失，MVP 够用；待办：SQLite 持久化"）。容器重启/宕机后提醒全丢
（8-12 宕机实测：用户设的提醒随进程消失）。

## 需求（做什么）

1. **reminders 表**（core SQLite）：`id TEXT PRIMARY KEY, text TEXT, trigger_at
   INTEGER, session_id TEXT, retry_count INTEGER`
2. **MemoryManager 公开方法**（Web 契约）：`saveReminder` / `removeReminder` /
   `listPendingReminders`（未触发全部，含已过期待补发）
3. **reminder.ts 注入 persist 回调**：set/cancel/fire 同步持久化
4. **启动恢复**：`restoreReminders(notifyFn, persist)`——未过期 → 重挂 timer；
   **已过期 → 立即补发**（重启期间错过的提醒不丢，用户设提醒的意图优先）
5. id 跨重启唯一：`reminder-${Date.now()}-${seq}`（不依赖内存自增）

## 设计决策

- 持久化在 core（与 EventLog 同库，Web 端后续可列提醒）
- 补发策略：过期即补发（用户设了提醒 = 意图明确；错过 >24h 的丢弃？——
  不，一律补发，时间文本含原触发时间，用户自行判断）
- 工具层无 db 句柄 → persist 回调注入（bootstrap 用 MemoryManager 方法实现），
  保持工具层可测试（内存 fake）

## 对账方向确认

- [x] doc 已声明（代码注释"待办"）→ 本 change 补实现

## 测试计划

- set → persist.save 调用（含 id/时间/会话）
- cancel → persist.remove 调用
- fire 触发 → persist.remove 调用（一次消费）
- restore：未过期重挂 timer（到时触发）；已过期立即补发
- 全量回归

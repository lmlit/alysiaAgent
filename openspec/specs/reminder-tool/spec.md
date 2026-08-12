---
status: active
source: （无旧文档，2026-08-07 治理对账补写；推送链路见 proactive-messages spec §4）
migrated: 2026-08-07
---
# 提醒工具（Reminder）— 设计文档

> 日期: 2026-08-07（补写——实现已存在，原无 spec 覆盖）

## 1. 背景与目标

给 AI 提供"定时提醒"能力：用户说"10 分钟后提醒我喝水"，AI 调工具设置提醒，
到点通过主动消息推送给用户。与 ProactiveService（固定时段问候）正交——提醒是
用户显式要求的、一次性、内容由用户指定。

## 2. 工具定义（core/tools/reminder.ts）

| 工具 | 参数 | 行为 |
|------|------|------|
| `set_reminder` | `time`: `"30min"` / `"1h"` / `"2026-07-21 14:00"`；`text`: 内容 | 解析时间 → setTimeout → 到点调 notifyFn；返回 `Reminder set: "<text>" at <time>.`；delay > 24.8 天拒绝 |
| `list_reminders` | 无 | 列出活跃提醒：`[id] 将在 <时间> 触发（内容仅到时可见）`——**不返回内容**（防 LLM 提前泄露） |
| `cancel_reminder` | `id` | 取消提醒（clearTimeout + 移除） |

**存储**（8-12，reminder-sqlite-persistence）：内存数组负责调度（timer）+ **SQLite
持久化**（core `reminders` 表：id/text/trigger_at/session_id/retry_count）。
set/cancel/fire 经 persist 回调（bootstrap 用 `MemoryManager.saveReminder` /
`removeReminder`）同步落库；**启动恢复** `restoreReminders`：未过期 → 重挂 timer，
**已过期 → 立即补发**（用户设了提醒 = 意图明确，重启期间错过的提醒不丢）。
id 跨重启唯一：`reminder-${Date.now()}-${seq}`。

**推送失败重试**（8-08）：`notifyFn` 返回 `boolean`（true=已处理）；失败（throw 或返回 false）
→ 5min 后重试一次 → 再失败丢弃并 warn。非私聊/仅日志路径返回 true（视为已处理）。

**错误处理**：
- 非法时间格式 → `Error: Invalid time format. Use "30min", "2h", or "2026-07-21 14:00".`
- 时间已过 → `Error: Reminder time must be in the future.`
- 取消不存在 id → `Error: Reminder with ID <id> not found.`
- 超长提醒（delay > 2^31-1ms ≈ 24.8 天——Node setTimeout 超限会立即触发）
  → `Error: Reminder too far in the future (max ~24 days).`（8-08）

## 3. 推送链路（bootstrap 注册 notifyFn）

```
set_reminder 设置时记录 sessionId
  → 到点 notifyFn(text, sessionId)（bootstrap 注册）→ 返回 boolean 给重试判定
     → sessionId 解析 openid（:private:private_(.+)$）
        → LLM 润色：以昔涟语气生成自然提醒文案（30-60字，失败回落 `⏰ ${text}`）
        → qqOff.sendProactive(openid, message)
        → 日志: Reminder push → <openid前8字>...: sent/failed
        → 失败 → 5min 重试一次（reminder 层调度）
```

非私聊会话提醒只打日志不推送。

## 4. 注册方式（工具注册器）

- `createReminderTool(notifyFn, persist)` → 注册 `set_reminder`
- `createListRemindersTool()` / `createCancelReminderTool(persist)` → 注册 `list_reminders` / `cancel_reminder`
- `restoreReminders(notifyFn, persist, pending)` → 启动恢复（bootstrap 启动时调用）

## 5. 待办（已记 memory，后续优化）

- [ ] 到时推送的 LLM 润色失败率观测（现回落原始文案）

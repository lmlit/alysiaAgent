# Spec 变更: fix-session-end-window

> 本 change 给 `openspec/specs/memory-system/spec.md` **追加**一节
> 「SessionEnd 三入口的窗口锚点契约」，apply 时合并。

---

## 1. `memory-system` §3.3 追加：窗口锚点契约

> 背景：§3.3 当时只描述了 **cron 路径**（`archiveStaleSessions`）的锚点，
> 从未声明 `onSessionEnd` / `extractProfile` 可以不带锚点。
> 实现里这两个入口**没传 `since`**，于是 `EventStore.getBySession` 落到
> 「全历史 DESC LIMIT 1000」——线上 76% 的摘要窗口跨度 > 24h，
> 29 条恰好 1000 条消息、跨度 46~61 天。

```diff
 2. **定期归档**（cron 每 6h 调 MemoryManager.archiveStaleSessions）：24h 内有消息的
    活跃 session → SessionEndProcessor.process(sessionId, since?) 摘要归档；
    since = 该 session 最新摘要 ended_at（ConversationStore.getLatestBySession），
    无摘要则回退 24h 前——防对同一批消息重复摘要。
+
+#### 3.3.1 ★ SessionEnd 三入口的窗口锚点契约
+#### （2026-10-11，change: fix-session-end-window）
+
+`MemoryManager` 有**三个** SessionEnd 入口，**每一个都必须传窗口锚点**：
+
+| 入口 | 触发方 | 频率 |
+|---|---|---|
+| `archiveStaleSessions()` | cron 每 6h | 4 次/天 |
+| `onSessionEnd(sessionId)` | 聊天回合 `usage.input > 8000`（`llm-agent.ts:270`） | 每次命中一次 |
+| `extractProfile(sessionId)` | Web 端「提取画像」按钮 | 按需 |
+
+**契约 1：锚点只有一处定义。**
+
+```
+since = ConversationStore.getLatestBySession(sessionId)?.ended_at
+        无历史摘要 → 回退 24h 前
+```
+
+该规则必须由**唯一的 helper** 提供，三个入口共用。
+「同一个规则写多份」正是本次故障的成因：cron 那份写对了，另外两份漏了。
+
+**契约 2：不传锚点的 `process(sessionId)` 是 bug，不是合法用法。**
+
+`SessionEndProcessor.process(sessionId, since?)` 的 `since` 缺省不是
+「从头开始」，而是**「取该会话全历史最近的 1000 条事件」**
+（`EventStore.getBySession` 缺省 `limit=1000`、无窗口条件）。
+后果不是「稍微多摘要一点」，而是：
+
+1. 窗口横跨数十天，同一段历史被反复摘要
+   （线上实测：45 秒内连摘三次，`started_at` 相差 1 分钟）；
+2. 1000 条消息的 prompt 让摘要槽**稳定失败**
+   （线上 8 天 10 次空响应 + 4 次 `truncated=true`）；
+3. 单次耗时从 ~6s 涨到 **19~35s**；
+4. 摘要经 `ConversationStore.getRecent()`（按 `started_at DESC`）注回 prompt
+   → prompt 膨胀 → 更易命中 `usage.input > 8000` → **正反馈**。
+
+**契约 3：`archiveStaleSessions` 内的两个 `since` 语义不同，不得合并。**
+
+- `getActiveSessions(since)` 的 `since` = **「24h 内有过活跃」的筛选门槛**
+- `process(sid, anchor)` 的 `anchor` = **「上次摘到哪」的窗口起点**
+
+两者数值常常不同（新会话无摘要时 anchor 回退 24h，而门槛始终是 24h）。
+把二者并成一个变量会让「很久没说话的会话」被漏掉。
```

## 2. 明确不涉及

- **不改 `SessionEndProcessor.process()` 签名**（它从 9-26 起就支持 `since` 并下推到 SQL）
- **不改 `EventStore.getBySession` 的 `limit` 缺省 1000**（窗口内的安全上限本身合理）
- **不改 `llm-agent.ts:270` 的 `usage.input > 8000` 触发条件**（属独立 change）
- **不清理线上已有的 29 条超长窗口摘要行**（属数据回填，需独立 change + 备份）
- **不改任何采样槽数值**
- **不加 Web API**：`extractProfile` 签名与返回结构不变，只在 `docs/Web-API-Design.md` 补行为说明

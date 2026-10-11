# Tasks: fix-session-end-window

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## core · MemoryManager（唯一锚点规则）

- [x] `src/memory/MemoryManager.ts`：新增私有 helper `summaryAnchor(sessionId): Date`
      —— 锚点 = `getLatestBySession().ended_at`，无摘要 → 24h 前；
      带 `logger.debug` 打出锚点便于部署后核对
- [x] `onSessionEnd`：`process(sessionId, this.summaryAnchor(sessionId))`
- [x] `extractProfile`：同上
- [x] `archiveStaleSessions`：改用同一 helper（**行为不变**）
      ⚠️ 保留 `getActiveSessions(since)` 那个独立的 `since`（筛选门槛），
      **没有**与锚点合并——两者语义不同（spec §5.4.1 契约 3）

## 测试

- [x] 新增 `packages/core/tests/memory/session-end-window.test.ts`（6 条）：
      - ★★ 有 `ended_at = T-1h` 的历史摘要 + 2 条 T-2h 事件 + 1 条 T-30m 事件
        → `onSessionEnd` 落库的新行 `message_count === 1`、`started_at` = T-30m
      - 无历史摘要 → 25h 前的事件不进窗口、1h 前的进
      - 窗口内无事件 → 不落摘要行（`no-events` 不是失败）
      - `extractProfile` 同样受锚点约束
      - cron 路径：有历史摘要时只摘锚点之后的（重构回归）
      - cron 路径：无历史摘要 → 仍回退 24h（重构回归）
- [x] 既有用例全绿（见验收表）
      - ✅ `tests/memory/integration/MemoryManager.test.ts` 的 `should handle session end`
      - ✅ `tests/memory/session-end-result.test.ts`
- [x] `tsc --noEmit` 退出码 0

## 文档

- [x] `openspec/specs/memory-system/spec.md`：新增 §5.4.1「SessionEnd 三入口的窗口锚点契约」
- [x] `docs/Web-API-Design.md`：§2.2 `extractProfile` 补「窗口语义」（签名/返回结构不变）
- [x] `docs/KNOWN-ISSUES.md`：**KI-19 根因坐实并修复**
      （原先的「疑似原因」第 2 条方向对了，真正机制是锚点缺失 → 每次触发都为同一段历史再造一条行）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [x] 更新 `openspec/specs/index.md`（`memory-system` 的「最后变更」）
- [x] **core build 说明**：本地无需单独 build —— Dockerfile 在容器内 `pnpm -r build`
- [ ] 更新 `docs/HANDOFF.md`
- [ ] 归档 + 更新索引

## 验收结果（2026-10-11）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **638 passed / 66 files** |
| 新增窗口用例 | ✅ **6 passed**（含 ★★ 核心回归） |
| `tsc --noEmit` | ✅ 退出码 0 |
| core build | ✅ 由 Dockerfile 在容器内 `pnpm -r build` 完成 |
| **部署后查数据**：新摘要窗口跨度 | ✅ **修复生效**。用线上真实数据触发同一个入口<br>（`POST /api/sessions/<qq-private>/extract`，即 Web「提取画像」按钮）：<br>**修复前**该入口产出 `span≈1106~1456h`、`mc=1000`；<br>**修复后**（10-11T04:08:51Z）新行 = **`span=4.8h`、`mc=2`** ✅<br>库内无新增 `message_count=1000` 行 |
| 副产物 | 该次验证意外暴露 **KI-21**（`al:memory-llm` 无超时 → 断网时 `extractProfile` 挂 117 分钟），已登记 KNOWN-ISSUES |

## 部署后验证（按 SOP 约定 8：部署后必须查数据，不能只看日志）

```sql
-- 期望：部署时刻之后不再出现窗口跨度 > 24h 的新摘要行
SELECT ended_at, started_at, message_count,
       (julianday(ended_at) - julianday(started_at)) * 24 AS span_hours
FROM conversations
WHERE ended_at > '<部署时刻>' ORDER BY ended_at DESC;
```

- 新行 `span_hours` 应 ≤ 24；`message_count` 应是个位数（对照修复前 1000）
- `[Memory] onSessionEnd done (Xms)` 应从 19~35s 回落到 ~6s 量级
- `[Memory] summary anchor for …` 可在 `ALYSIA_DEBUG=1` 时看到锚点值

## 刻意不做（记录在案）

- ❌ **不改 `llm-agent.ts` 的 `usage.input > 8000` 触发条件**
- ❌ **不动 `EventStore.getBySession` 的 `limit` 缺省 1000**
- ❌ **不清理线上已有的 29 条超长窗口摘要行**（属数据回填，需独立 change + 备份锚点）

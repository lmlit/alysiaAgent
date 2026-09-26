# Tasks: fix-session-event-window-truncation

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## A. 修正查询语义

- [x] `EventStore.getBySession(sessionId, opts?)` 改为「最近 N 条、可 `since` 过滤、升序返回」
      （先 DESC 取最近 N 条，外层 ASC 排回来）
- [x] 窗口过滤**下推到 SQL**（原实现是"取 1000 条再内存 filter"）
- [x] `SessionEndProcessor.getSessionEvents(sessionId, since)` 透传
- [x] `retryFailedSummary` 同样改走 SQL 窗口

## B. 让空转不再伪装成成功

- [x] 新增 `SessionEndResult`（`{ summarized, reason }`），`process()` 返回它
- [x] 四类 reason：`no-events` / `no-messages` / `no-dialogue` / `summary-failed`
- [x] `archiveStaleSessions` 按真实结果分别计数（archived / skipped / failed）
- [x] 日志区分「跳过（无新内容）」与「失败」——原日志两者都是 `archived`

## 测试

- [x] 核心回归：1436 条事件 + anchor 在最后 20 条之前 → **必须取到**（原实现取到 0）
- [x] 超 LIMIT 时取最近的 N 条（不是最旧的）
- [x] 无 `since` 时取最近 N 条（不是最旧的）
- [x] 升序返回、`since` 早于/晚于全部事件的边界
- [x] `process()` 四种 reason 各一条测试
- [x] core 519 / server 192 全过，类型检查干净
- [x] **端到端（真实生产数据 + 真实 API）**：见下

## ★ 端到端验证（`scripts/verify-window-fix.ts`，跑在**生产库副本**上）

- [x] 导出生产库副本（**不覆盖本地库、不碰生产**）
- [x] 复现旧行为：取到 1000 条、窗口内 **0 条** → 空转（与线上现象一致）
- [x] 新代码：`archived 1/1`、conversation **134 → 135**、窗口内 **20 条**被摘要
- [x] 摘要内容是**真实生成**的（非占位符）："昔涟从中秋前夜到次日傍晚…"
- [x] 顺带印证遗留问题：存量老行确实 `summary_status='ok'` 且内容是占位符

## Apply 任务（实现完成后）

- [ ] 合并 `spec-memory.md` 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`
- [ ] 提交前敏感审查
- [ ] 部署到服务器（**这是生产管道真正恢复的关键一步**）

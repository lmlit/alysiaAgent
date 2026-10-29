# Tasks: resolve-fact-conflicts

## 1. 数据层
- [x] `database.ts` 建 `fact_conflicts` 表 + 部分唯一索引 + status 索引
- [x] `FactConflictStore`：create/dedupe/list/markAsked/resolve/expire/closeForSupersededOld/stats
- [x] `ProfileFact` 增加 `conflicts_with?` / `confirmed_at?`；`migrateFact` 保留

## 2. 冲突检测
- [x] `PROFILE_EXTRACT_SYSTEM_PROMPT` 增加 `conflicts_with` 输出约束
- [x] `ProfileExtractor.extract(events, existingFacts)`：注入活跃事实列表（≤120 条）
- [x] `toFact` 只在有值时带 `conflicts_with`（不改变既有输出形状）
- [x] `SessionEndProcessor` 两处调用传 `getCurrentFacts()`

## 3. 写入分流
- [x] `ProfileStore.addFact/addFacts`：user 立即覆盖；inferred/behavior 冲突入队；
      旧 user vs 新 inferred 丢弃；同 key 无 flag 也走同一逻辑
- [x] 队列创建日志、上限/过期逻辑
- [x] 用户用第三个值覆盖旧条时，自动清理挂在旧条上的候选（不再问已作废的旧说法）
- [x] `ProfileStore.resolveFactConflict(id, keep)`：事务内改 facts + conflict 行
- [x] `MemoryManager.listPendingFactConflicts/listFactConflicts/resolveFactConflict/getFactConflictStats`

## 4. Prompt / 工具 / API
- [x] `pendingConflict` 块（required，effect=write，一次 1 条，含 conflict_id）
- [x] 注入后 `markAsked`；有冲突时暂不注入过期 pendingConfirm（避免双问）
- [x] facts 块：`source=inferred` 且 `confirmed_at` 存在时不显示“（待确认）”
- [x] `resolve_profile_conflict` 工具
- [x] `GET /api/profile/conflicts` / `POST /api/profile/conflicts/:id/resolve`
- [x] `docs/Web-API-Design.md` 同步

## 5. 测试
- [x] `FactConflictStore` 单测（去重/冷却/裁决/过期/上限）
- [x] `ProfileStore` 单测（user 立即、inferred 入队、user vs inferred 丢弃、keep old/new、第三值清理）
- [x] `PromptAssembler` 单测（块内容/required/不丢/asked_at/confirmed_at）
- [x] `ProfileExtractor` 单测（已有事实进 prompt、conflicts_with 映射）
- [x] 更新 block-registry / SessionEnd mocks / self-evolve 工具数
- [x] 全量测试：**175 文件 / 2021 用例全绿**（Node 24）
- [x] 本地真机 smoke 通过
- [x] 本地真机聊天 3 轮通过（`scripts/chat-local.mjs --fresh --turns 3`）
- [x] 本地真服务冲突 API 端到端：GET pending → POST keep=new → facts 旧 superseded / 新 active + confirmed_at

## 6. 部署与归档
- [x] 提交：`384fba5`（feature）+ `197ee8e`（Docker Alpine mirror）
- [x] 部署生产：2026-10-29 22:11（`rollback-20261029-221119`）
  - `docker ps`: `server-alysia:latest Up (healthy)`
  - `/api/health`: `{"status":"ok"}` / HTTP 200
  - 生产库 `fact_conflicts` 表存在，22 列齐全，pending=0
  - 容器内 dist 含 `pendingConflict` / `resolve_profile_conflict`
- [x] 归档到 `openspec/archive/2026-10-28-resolve-fact-conflicts/`
- [x] 更新 `docs/TODO.md` 链接（change → archive）

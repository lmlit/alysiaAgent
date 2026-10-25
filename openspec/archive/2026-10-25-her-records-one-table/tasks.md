# Tasks: her-records-one-table

## 存储合并
- [x] `database.ts`：新表 `ai_life_records`（kind/visibility/date/content/mood/mood_value）
      + `UNIQUE(kind,visibility,date)` + 迁移索引
- [x] 幂等迁移：旧日记 → `diary/shared`；`ai_life_state.reflection` → `reflection/private`
- [x] `LifeStore`：`saveRecord` / `listRecords` / `lastRecordTail`
- [x] 兼容层：`saveDiary`/`listDiaries`/`getDiary`/`getLastDiaryTail` 全走新表（新表空则回落旧表）
- [x] `MemoryManager`：`saveHerRecord` / `listHerRecords` / `hasHerRecord`
- [x] `recordReflection`：反思正文从"写 state（无人读）"改为**逐日累积进记录表**

## 私密日记（不加滤镜）
- [x] `LIFE_PRIVATE_DIARY_PROMPT`（第一人称 2-4 句 ≤120 字 / 只写真实发生的事 / 不许写"希望他看到"）
- [x] `LifeService.maybePrivateDiary()`（独立试错、独立跨天去重 `privateDiaryDate`）
- [x] 采样槽 `life.privateDiary`（0.9 / **max_tokens 2048**，KI-1 教训）
- [x] `modules/life.ts` 注入 `generatePrivateDiary`（独立 sessionId + 预算现场日志）

## 回读（这才是日记）
- [x] `LifeService.buildPrivateDiaryBlock(limit)`：最近 N 篇，每篇截 80 字
- [x] 进**生活事件生成** context（`【你最近写下的】`）
- [x] 进**私密日记自身**（接上上一篇，保持连续）
- [ ] 进次日反思（下一批；同一 helper 复用）

## 测试
- [x] `her-records.test.ts` 9 例（覆盖/并存/隔离/累积/tail/兼容层/旧表回落）
- [x] `life-service.test.ts` +3 例（写了才存在 / 无生成器不写 / ★回读进 life context）
- [x] 全量 **169 文件 / 1974 用例**

## 本地真机验证
- [x] 注入旧日记 + 旧反思 → 起本地真服务 → **两条都搬进新表**（反思首次变得可读）
- [x] 再启一次仍 2 条（**幂等**）；对话照常
- [x] ★ 小坑：`ai_life_state` 在新库里没有行，`UPDATE ... WHERE id=1` 匹配 0 行
      ⇒ 种子脚本必须 `INSERT OR REPLACE`（否则会误判"迁移没生效"）

## 部署
- [x] `pnpm deploy`（smoke 闸；镜像 rollback 点 `rollback-20261025-175252`）
- [x] 部署后核对生产：**5 篇 diary(shared) + 1 条 reflection(private)**，legacy 5 篇冻结未删
- [x] 归档到 `openspec/archive/2026-10-25-her-records-one-table/`
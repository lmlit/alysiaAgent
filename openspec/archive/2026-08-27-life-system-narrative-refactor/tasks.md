# Tasks: life-system-narrative-refactor

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 改动集中在：`database.ts` / `LifeStore.ts` / `MemoryManager.ts` / `life.ts` / `bootstrap.ts` / `loader.ts`，新建 `daily_life.md`。

## 实现任务

### P0

- [x] T1 database.ts 迁移：`ai_life_state` 加 mood_value；`ai_life_events` 加 origin；`life_templates` 加 category/group_name；新建 `ai_life_scene_presence` 表（全部 ALTER + try-catch，不 DROP）
- [x] T2 模板扩容种子：43 条（独处 20 / 互动 12 / 分享 11），按角色关系分组（none/迷迷/风堇/遐蝶/白厄/其他人），幂等 INSERT OR IGNORE + 旧 seed 补分类 UPDATE
- [x] T3 LifeStore：presence 读写（list/upsert/listNames/presenceStaleHours）、moodValue 读写、origin/category/groupName 存取
- [x] T4 MemoryManager（只加方法）：listScenePresence / listPresentCharacters / upsertScenePresence / recordLifeEvent 支持 origin / getLifeSnapshot 返回 moodValue + updatedAt
- [x] T5 getWorldbookSample 分层随机：life_event 随机 3 + text 随机 2（ORDER BY RANDOM()），截断 200 字
- [x] T6 新建 `persona/worldbook/daily_life.md`（12 条 life_event：住所/饮食/爱好/习惯/童年）+ loader.ts 纳入 WORLDBOOK_FILES + FILE_META 标记 content_type='life_event'/scope='both'/priority 8
- [x] T7 life.ts 事件生成：prompt 注入【在场角色】+【心情】块（mood_value 极性）+ 余波任务 + 修正提示；事件 JSON 扩展 mood_shift / agency.can_contact
- [x] T8 life.ts 情绪惯性：mood_value 累积（同向加成 ×1.5/反方向 ×0.5 再移/8h 线性回归 0）+ mood 文本极性联动
- [x] T9 life.ts post-check 7 条（长度/硬设定黑名单/报备词/前 12 字去重/连续 3 internal/引号引用/不在场角色；失败 → 带反馈重试 1 次 → 回落模板）
- [x] T10 life.ts 推送判定：type=chat && !deepNight && 冷却 && 上限 && agency.can_contact !== false
- [x] T11 life.ts 对话余波：最后 user 消息 15min-3h 且 3h 内无 followup → 生成 internal 余波（origin='followup'，不推送，回写记忆 + 情绪 + 在场）
- [x] T12 bootstrap.ts：generateEvent systemPrompt 更新（9 条约束 + mood_shift + agency 字段说明）

### 测试

- [x] T13 单元：mood_value 三规则（加成/衰减/回归）+ 极性联动（life-service.test.ts 4 例）
- [x] T14 单元：post-check（硬设定/在场角色 2 例）
- [x] T15 单元：在场推导 + prompt 注入 + 模板在场组优先（life-service.test.ts 6 例）
- [x] T16 单元：getWorldbookSample 分层随机 + 截断（life-methods.test.ts 2 例）+ LifeStore 新方法（life-store.test.ts 5 例）
- [x] T17 集成：life.ts mock generateEvent 全流程（can_contact 门 2 例/余波 3 例/心情注入）
- [x] T18 回归：core 365 + server 116 = 481 全绿（Node 24，`--exclude='tests/memory/e2e/*'`）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（未执行——8-27 版 spec.md 即新 spec 全文，归档时直接替换）
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [x] 更新 `docs/Web-API-Design.md`（getLifeSnapshot 新字段——见下）
- [x] 运行测试验证（481 全绿）

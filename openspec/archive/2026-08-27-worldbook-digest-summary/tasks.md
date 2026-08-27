# Tasks: worldbook-digest-summary

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] T1 database.ts：`worldbook_entries` 加 `digest` 列（ALTER + try-catch；INSERT 时默认 NULL）
- [x] T2 MemoryManager：getWorldbookSample 优先返回 digest（content 字段 = digest ?? 截断正文）；digest 为空串也回落
- [x] T3 新建 `packages/server/scripts/digest-worldbook.ts`：无 digest 的 text 条目 → LLM 生成 120-150 字简介 → UPDATE（幂等可重跑；**并发 --concurrency 4-6 + 重试 5 次**；空响应概率 ~20% 已实测）
- [x] T4 测试：getWorldbookSample digest 优先 / 缺失回落 / 空串回落（life-methods.test.ts +3）
- [x] T4b 修复 seed 清空 digest（关键）：importRole 的 delete+insert 会把已生成 digest 重置 NULL（多轮生成被清的根因）——**delete 前缓存旧 digest**，insert 带 digest 列（WorldbookStore.insert + WorldbookEntry 类型同步）

## 生成任务（一次性）

- [x] T5 生成 **48/66 条**（73%）。失败 18 条为剧情 lore（轮回/黑潮/铁幕/最终章等 500+ 字暗黑宿命内容，DeepSeek 系统性空响应，重试 5 次无效）——**对生活事件生成价值最低，回落截断 200 字兜底**。主力角色条目（白厄/风堇/遐蝶/万敌/那刻夏/三月七等）全部就绪

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（最后变更列）
- [ ] 运行测试验证

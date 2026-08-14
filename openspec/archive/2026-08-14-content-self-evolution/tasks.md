# Tasks: content-self-evolution

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（TDD），本文件只记账。

## 实现任务

- [x] 1. `database.ts`：新建 `life_templates` 表（id/activity/type/weight/source/created_at）+ seed 8 条既有模板（source='seed'）；`worldbook_entries` ALTER 加 `source` 列（PRAGMA 存在性检查，默认 'seed'）
- [x] 2. `MemoryManager`：新增 `addWorldbookEntry`（机械预检 + LLM 校验 + INSERT + logger.info 审计）、`listWorldbookEntries`、`deleteWorldbookEntry`、`addLifeTemplate`（同构）、`listLifeTemplates`、`deleteLifeTemplate`
- [x] 3. LLM 校验器：`validateSelfEntry`（复用 llmService.complete，判定 prompt + write/reject 解析，异常降级拒写）
- [x] 4. `tools/self-evolve.ts`：`write_worldbook` / `add_life_template` / `delete_worldbook_entry` / `delete_life_template` 四个工具（description 行为准则：只写自己的事、用户事实不写、模糊不写；删除仅响应明确指令）
- [x] 5. `registerChatTools` 注册新工具
- [x] 6. `tools/worldbook.ts`：lookup_worldbook 实时化（handler 每次实时查询，去掉启动冻结 index）
- [x] 7. `life.ts`：删除 `LIFE_TEMPLATES` const + `life-templates.ts`，`pickTemplate()` 改从 `memoryManager.listLifeTemplates()` 读
- [x] 8. `webui/server.ts`：`GET/DELETE /api/worldbook`、`GET/DELETE /api/life/templates`
- [x] 9. `docs/Web-API-Design.md`：6 个新方法登记（2.6 生活系统 / 新 worldbook 小节）
- [x] 10. 测试：MemoryManager（写入/查重拒/LLM 拒/降级拒写/list+delete）+ self-evolve 工具 + worldbook 实时化 + life-service 适配（pickTemplate 库读）——全绿（core 337 非 E2E + server 93；2 个 E2E 失败为无 .env 环境问题）

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md` + `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（memory-system / ai-life-system 最后变更行）
- [ ] 运行测试验证 + 汇报

# Change Proposal: content-self-evolution

## 元信息

- **日期**: 2026-08-14
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `memory-system`（worldbook 自写 + LLM 校验器 + MemoryManager 方法）、`ai-life-system`（life 模板池迁库）

## 动机（为什么做）

昔涟当前的持久内容全是**启动时冻结**的：worldbook 只有角色包导入/seed，life 模板是写死的 const，lookup_worldbook 启动构建索引后查不到新内容。她不会"长大"——她的设定、往事、日常习惯无法积累。

方向文档 v2（用户 8-14 给定）确立语义：**她可以往自己的持久内容库写新条目**（新回忆/设定 → worldbook；新日常活动 → life 模板池），写完在对话里自然提一嘴通知用户，用户觉得不对就事后改。不事前请示、不问"行吗"。安全靠事后（校验滤离谱 + 对话浮现审计面 + 单用户 blast radius 小 + 模糊不写），不靠事前审批门。

## 需求（做什么）

- [ ] 工具 `write_worldbook`：昔涟自写世界书条目（trigger_keys + content，≤250 字）
- [ ] 工具 `add_life_template`：昔涟自加日常活动模板（activity + type）
- [ ] 写入校验：机械预检（查重/长度/空触发词）+ **LLM 校验器**（一次 complete 判定 write/reject）；校验失败降级为**拒写**（宁可漏记不误记）
- [ ] 无事前审批；通知=对话内容浮现（工具 result 可见，主循环 LLM 自然带出），审计双轨：`logger.info` 硬记录 + `source='self'` 标记
- [ ] 删除工具 `delete_worldbook_entry` / `delete_life_template`：**仅响应用户明确指令**，LLM 不得自主删除；删除日志留完整内容（可找回）
- [ ] `lookup_worldbook` 实时化（当前启动冻结，写了查不到 = 自相矛盾）
- [ ] LIFE_TEMPLATES const → `life_templates` 表（seed 8 条既有种子，source='seed'），`pickTemplate()` 改从库读
- [ ] `worldbook_entries` 加 `source` 列（ALTER，带存在性检查；seed/import = 'seed'，自写 = 'self'）
- [ ] webui 管理端点：`GET/DELETE /api/worldbook`、`GET/DELETE /api/life/templates`（硬审计面 + 用户事后删除兜底）
- [ ] 自写条目自然进"worldbook 喂 life 生成"链（getWorldbookSample 已含，无需改动——自加条目入库即生效）

## 设计决策（怎么做，含备选与取舍）

1. **校验器 = LLM 校验器（用户选定 B）**：机械预检（查重/长度/格式，规则最可靠的先挡）→ 一次 LLM complete（max_tokens 128、低温）判定 write/reject。备选 A（纯机械，零成本但"离谱粗筛"无力）、C（规则+LLM 混合，过度）被否。判定 prompt 不给对话上下文，只给条目本身，防上下文污染。
2. **删除入口 = 对话内删除（用户选定 A）+ webui 列表兜底**：方向文档"删除只走用户"——用户指令驱动，LLM 用删除工具执行；description 硬约束不自主删。备选 B（纯 webui 端点，QQ 形态下用户要爬服务器浏览器）、C（/forget 命令式，生硬）被否。webui 列表是硬审计面 + 将来 Web UI 用。
3. **weight 固定 2**：新模板不暴露权重参数，防 LLM 权重操纵霸占模板池。
4. **校验失败降级拒写**：LLM 校验器异常/超时 → 拒写并返回原因，符合"模糊一律不写，不硬猜也不硬问"。
5. **不做删除权限外的工具能力**：LLM 可删（用户指令）但不可改已有条目（update 不暴露），防她改写自己历史；删除日志记录完整内容供找回。
6. **lookup_worldbook 实时化**：handler 每次调用从 db 实时查询（条目量小，成本可忽略），替换启动冻结的 index。

## 对账方向确认

- [ ] 是否与现有 spec 冲突？—— `ai-life-system` §14 声明模板在 `life-templates.json`（doc 旧），impl 实际是 `life-templates.ts` const（impl 对 doc 旧 → 改 doc）；本 change 将模板池整体迁库，§14 一并改写，无 spec-impl 方向冲突
- [ ] 涉及 Web API？—— 是。MemoryManager 新增 6 个公开方法（addWorldbookEntry / listWorldbookEntries / deleteWorldbookEntry / addLifeTemplate / listLifeTemplates / deleteLifeTemplate），同步更新 `docs/Web-API-Design.md`

## 测试计划

- MemoryManager 单测：写入成功（校验过）/ 机械查重拒 / LLM reject 拒 / 校验器失败降级拒写 / list+delete / source 标记
- self-evolve 工具单测：参数校验、result 形状（写入 vs 拒写提示）
- worldbook 实时化：写入后立即可查（方向文档核心矛盾点验证）
- life-service 适配：pickTemplate 从库读（seed 8 条），老测试 mock 调整
- webui 端点：GET/DELETE 冒烟（沿用现有测试模式）

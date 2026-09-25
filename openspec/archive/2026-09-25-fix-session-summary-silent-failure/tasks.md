# Tasks: fix-session-summary-silent-failure

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## A. 加固（让失败变少）

- [x] 抽取共用「LLM JSON 输出解析」工具（剥围栏 + 裸文本兜底 + 截断检测）→ `utils/llm-json.ts`
- [x] `life.ts` 改用共用工具，**行为不变**（server 192 测试全过，零回归）
- [x] `SessionEndProcessor` 改用共用工具
- [x] `sampling.ts`：`session.summary` 的 `max_tokens` 512 → 2048（+ `response_format: json_object`）
- [x] ★ **实测修正**：`life.generateSummary` 也是 512 → 2048（**每日反思的根因与此同源**，见下）
- [x] 该链路补 `response_format: json`
- [x] ★ 失败重试 1 次（实测：模型偶发返回空响应，重试可救回）

## B. 可见（让失败不再伪装成成功）

- [x] `generateSummary` 失败改为向上抛出（不再 `return defaultSummary`）
- [x] `process()` 失败分支：插行 + `summary=''` + `summary_status='failed'` + **不 embed**
- [x] `database.ts` 迁移：`ALTER TABLE conversations ADD COLUMN summary_status TEXT DEFAULT 'ok'`（try-catch，不 DROP）
- [x] `ConversationStore` 的 `getRecent` / `searchByText` 过滤 `summary_status='failed'`
- [x] `defaultSummary` 占位符字符串从代码中移除
- [x] ★ 顺带修：`MemoryManager.extractProfile` 的 `summaryGenerated` 不再**恒为 true**

## C. 补处理机制

- [x] `ConversationStore.getFailed` / `getPreviousEndedAt` / `updateSummaryResult`
- [x] `SessionEndProcessor.retryFailedSummary`（只补摘要，不重跑画像提取）
- [x] `MemoryManager.retryFailedSummaries` 接到 `archiveStaleSessions`（cron 每 6h 自动补）

## ★ 实测验证（真实 DeepSeek，`scripts/verify-session-summary-fix.ts`）

- [x] 修复前 3/3 失败、报错形态与线上逐字一致（`Unexpected end of JSON input` / `Unterminated string`）
- [x] 修复后：首次调用失败 1/3（模型抖动）→ **重试后 0/3 失败**
- [x] 根因确认：`reasoning_tokens=242`，**reasoning 与可见内容共用 max_tokens 预算**

## 测试

- [x] core 506 / server 192 全过（新增 34 个测试）
- [x] **反例测试**：断言 `summary LIKE 'Session %summary'` 永不出现
- [x] 迁移测试：老库（无该列）能升级且存量行不被误判为失败
- [x] 真实 DeepSeek E2E（上述实测脚本）

## Apply 任务（实现完成后）

- [ ] 合并 `spec-memory.md` 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [ ] 提交前敏感审查

## ⚠️ 部署依赖（本 change 落地的前置）

- [ ] **必须先解决 `tune-recall-with-runtime-data` 的矛盾**：本 change 不修，部署新版本
      攒召回数据时，摘要仍 100% 失败 → 基线被污染。**本 change 应先于/伴随部署**
- [ ] 上线后验证：`grep -c 'summary LLM failed'` 应显著下降；
      `SELECT COUNT(*) FROM conversations WHERE summary_status='failed'` 应可见

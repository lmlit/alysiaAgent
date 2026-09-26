# Change Proposal: backfill-failed-session-summaries

## 元信息

- **日期**: 2026-09-25
- **类型**: NEW（存量数据修复）
- **状态**: pending（**依赖 `fix-session-summary-silent-failure` 先落地**）
- **影响 spec**: `memory-system`（§2.4 Conversation Store 的存量数据，不改结构）

## 动机

线上权威库 `~/alysia/data/alysia.db` 有 **52 条** conversation 的 `summary` 是字面占位符
（`"Session <sessionId> summary"`），`topics` / `key_decisions` 为空。
成因与完整时间线见 `fix-session-summary-silent-failure` 的 proposal（本 change 不重复）。

**两个危害**：

1. **信息缺失**：长期记忆里这段时期的会话摘要不存在，后续检索/画像少一块
2. **垃圾向量污染召回**：`ConversationStore.ts:17` 拿 summary 文本 embed ⇒
   52 条**近乎相同**的垃圾向量在 LanceDB 里，可能被召回出来当真内容用，
   还会干扰正在调参的召回相似度分布（`tune-recall-with-runtime-data` 的基线会被带偏）

## ⚠️ 找法（2026-09-26 部署后补记，容易搞错）

这 52 条老行的 `summary_status` 是 **`'ok'` 而不是 `'failed'`**。

原因：`fix-session-summary-silent-failure` 只对**从新代码上线后**产生的失败打 `'failed'`
标记；存量行的 `summary` 是非空的垃圾字符串（`"Session <id> summary"`），
状态列没法把它和真摘要区分开。

⇒ **必须按内容模式匹配来找**：

```sql
SELECT COUNT(*) FROM conversations WHERE summary LIKE 'Session %summary';
```

**不要**用 `WHERE summary_status='failed'` 查存量——那会是 0，看起来像"没有要回填的"。

## 需求

- [ ] **先确认可回填性**（决定性的第一问）：这批会话的原始 events 是否还在 `events` 表里？
      `SessionEndProcessor.getSessionEvents(sessionId)` 按 session 取事件——
      若事件尚存且内容完整则可重摘要；若已被清理则只能标记为**永久缺失**
- [ ] 评估成本：52 条 × 摘要 LLM 调用 + embed，先算 token/费用再决定全量 or 抽样
- [ ] 回填脚本（幂等、支持 `--dry`，沿用 `backfill-life-importance.ts` 的模式）
- [ ] **清理垃圾向量**：LanceDB 中这 52 条 conv 的向量记录应删除或重建
- [ ] 回填后校验：`SELECT COUNT(*) FROM conversations WHERE summary LIKE 'Session %summary'` 应为 **0**
- [ ] 抽样人工检查回填质量（不能只看计数）

## 待定的关键决策

- **在哪跑**：生产库上直接写（**需明确授权 + 先备份**）vs 导出到本地改了再传回
- **回填 vs 放弃**：取决于上面"可回填性"的结论

## 对账方向确认

- [x] 与现有 spec 冲突？无——本 change **不改 spec 结构**，只修复存量数据
- [x] 涉及 Web API？不涉及

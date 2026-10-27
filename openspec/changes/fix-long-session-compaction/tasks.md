# Tasks: fix-long-session-compaction

## 1. 压缩请求冷却
- [x] 新增纯函数 `shouldRequestCompaction()` + `COMPACTION_COOLDOWN_MS`
- [x] `LLMAgentStage` 记录 per-session 上次请求时间；冷却内不重复 `onSessionEnd`
- [x] 单测：低于阈值 / 首次 / 冷却内 / 冷却后

## 2. skipped 不算失败
- [x] `llm-agent` 的 `.then`：仅 `summary==='ok'` clear、`summary==='failed'` mark；
      `skipped` 只记 info，不暂停截断（判据收进 `shouldHoldTruncation()`）
- [x] 保留 `.catch` → mark（真异常仍 hold）

## 3. facts 预算保护
- [x] `block-registry`：`facts.policy` 改 `required`，note 说明原因
- [x] `PromptAssembler`：facts 去重后取置信度前 40 条（`FACTS_IN_PROMPT`）
- [x] 更新 `block-registry.test.ts` 的 required 清单
- [x] `PromptAssembler` 单测：50 条事实 → 只注入 40 条且块不丢

## 4. 验证与归档
- [x] Node 24 全量测试：**171 文件 / 1992 用例全绿**
- [x] 本地 `pnpm chat -- --fresh --turns 4` 真聊（4 轮均正常，1.6–1.9s）
- [ ] 部署生产 + 记录回滚点/健康检查
- [ ] 更新 memory-system spec、归档

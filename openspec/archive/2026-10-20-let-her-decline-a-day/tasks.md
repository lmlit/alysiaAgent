# Tasks: let-her-decline-a-day

- [x] `LifeOpts` 加 `generateDecline` / `declineChance`
- [x] `LIFE_DECLINE_PROMPT`（`prompts/life.ts`）：具体 / 不道歉 / 不向用户喊话
- [x] `modules/life.ts` 注入回调（采样用低温 `life.generateSummary` 槽）
- [x] `LifeService.maybeDecline()` + `buildDeclineContext()`（不消费一次性信号）
- [x] tick 的 ③-pre 调它；返回 `true` 即结束本轮
- [x] 拒绝路径**续期锁**（P1-6 的原始担忧不许回归）
- [x] 四条护栏：概率 0.15 / 连续上限 2 / 理由 ≥6 字 / **fail-open**
- [x] `origin='decline'` 类型扩展（`LifeStore` + `MemoryManager`）
- [x] 正常产出后 `consecutiveDeclines` 归零
- [x] 测试 `packages/server/tests/life-decline.test.ts`（9 条）
- [x] `ai-life-system` §11.2（6 条契约）+ §2「锁续期」行澄清
- [x] 全量测试（Node 24，免 API）
- [x] 归档 + 更新索引 + `docs/TODO.md` 销账

## 说明

- proposal 与 apply **同轮完成**：用户当日明确拍板「可以拒绝」，
  且契约（四条护栏）在实现前已由 `tie-intimacy-to-speech` 的「规则 5」记录在案。
  这里保留完整 proposal 是为了留下**判断依据**，不是补流程形式。
- 未跑真实 E2E：拒绝判定是本机概率 + mock 理由生成，不依赖外部 API。

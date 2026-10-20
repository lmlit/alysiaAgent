# Tasks: tie-intimacy-to-speech

## 前置取证（实现前必须先做，别直接写代码）

- [x] 确认 `LifeService` 里**没有**现成的 idle 计算 —— ⚠️ **有**，但它是 `updateIntimacy` 内部的
      **7 天窗口近似**（`getRecentMessages(sessionId, 500, since7d)`，无 user 消息记 7 天）。
      结论：**不合并**。那个用于衰减幅度（窗口近似即可），档位要的是**真实间隔** ⇒ 新加 `getLastUserMessageAt`
- [x] 确认 `EventStore` 不直接有「最后一条 user 事件」：新增 `getLastUserMessageAt()`
      （⚠️ role 在 `payload` 的 JSON 里，且必须排除 `skip_profile`/`synthetic` 机器注入）
- [x] `MemoryManager.getLastUserMessageAt()`（只读纯数据）已登记 `docs/Web-API-Design.md` §2.6

## 实现

- [x] `life.ts`：`INTIMACY_TIERS` / `intimacyTier()` / `INTIMACY_UPGRADE_MARGIN` / `INTIMACY_RECOVERY_MIN`
- [x] `life.ts` 推送判定：`effectiveCap = min(配置, 档位)`；冷却按档位取；`silent` 档 cap=0 不推送
- [x] 档位迟滞：升档需越阈值 **+5**（`state.intimacyTier` 作基准）
- [x] 降档/升档留痕：`[Life] intimacy tier A → B（亲密度 X，idle N 天，日上限 M→K）`
- [x] 「最近在忙吗」：7 天一次（`state.lastAskAt` 持久化）
- [x] 「他回来了」：`state.wasSilent` + `state.recoveryPending`，**一次性消费**
- [x] `【你和轻月】` 块注入事件生成器（只给事实）

## ★ 实现时发现并修掉的缺陷（不在原 proposal 里）

- [x] **每日推送计数每 tick 被清零**：复位原写在 `maybeGenerateDailySummary` 里，
      判据 `lastSummaryDate !== today`，而它**只在摘要成功后置位** ⇒
      无回调 / 摘要连续失败时计数天天归零 ⇒ **每日上限形同虚设**（实测：上限 3 发出 4 条）。
      改为 `resetDailyPushCount()` 按 `state.pushCountDate` 复位，与摘要成败**解耦**。
      契约写进 `ai-life-system` §11.1 **契约 8**，并补了一条回归测试。

## 两处与原 proposal 的偏离（都是成本/质量权衡，已写进 spec）

- 「他回来了」**不额外造一条 internal 事件**，改为**由下一次事件生成消费**
  （`recoveryPending` 一次性）：少一次 LLM 调用，也不会写出"人回来了"这种生硬文本
- 「在忙吗」**不单起一次 LLM 调用**，作为生成提示注入（7 天冷却）：
  复用既有生成链路，零额外成本

## 测试

- [x] 四档映射 + 只降不升 + `silent` 不推 + 迟滞 + 恢复一次性 + 「在忙吗」7 天（7 条）
- [x] `getLastUserMessageAt` 的三条排除（6 条，含"机器注入不得刷新 idle"）
- [x] **回归**：同一天内摘要失败不得清零推送计数（1 条）
- [x] 全量（Node 24，免 API）：**137 文件 / 1730 测试全绿**

## 收尾

- [x] `ai-life-system` §11 用途改写 + 新增 §11.1（契约 1-8）+ §2 决策表补行
- [x] 归档 + 更新索引 + `docs/TODO.md` 销账
- [ ] 真实 E2E（需 `.env`）—— 本 change 未跑，因为判定逻辑全是本地纯函数/DB 查询

## 关联（不在本 change 内）

- `let-her-decline-a-day` —— 拒绝权（需先改写 §2 的 P1-6「永不静默停摆」）

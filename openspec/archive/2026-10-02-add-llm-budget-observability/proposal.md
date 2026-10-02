# Change Proposal: add-llm-budget-observability

## 元信息

- **日期**: 2026-10-02
- **类型**: NEW（可观测性；顺带修一处静默吞错）
- **状态**: archived（2026-10-02 实现 + 验证完成；apply 已合并回 `memory-system` §4.1.2 / `ai-life-system`）
- **影响 spec**: `memory-system`（§4.1.1 采样槽契约 + 新增观测契约）、`ai-life-system`（事件生成链路日志）

## 动机（为什么做）

`docs/KNOWN-ISSUES.md` **KI-1**：`life.generateEvent` 槽**没有 `max_tokens`**，走服务端默认值（未知量）。
而 `CHAT_MODEL` 是**推理模型**——reasoning 与可见内容**共用同一预算**，这套机制**已经造成三次线上事故**
（会话摘要 22 天 100% 失败 / 每日反思 11 次空响应 / 画像提取静默停摆 6 个月）。

KI-1 与它们**同形**：要输出多字段 JSON（`content` 2-4 句 + `message` + `agency` + `intent` + `next_in_hours`…），
且项目 8-27 / 8-28 两次主动把事件**越写越长**。推理 + 长 JSON 双重吃预算。

**但按项目方法论不能直接填一个数字**（HANDOFF 约定 6：改 prompt / 换模型 / 调采样后必须跑真实 API 探针；
这个数字**单测结构性抓不到**，LLM 是 mock 的）。**先取证据再改代码**——上次正是先加临时观测
拿到 `reasoning_tokens / finish_reason=length`，才定位到推理预算这个机制。

**问题是：现在拿不到这个证据。** 两处具体缺口：

### 缺口 1：`finish_reason` / `reasoning_tokens` 根本没被解析

`OpenAIProvider.textChat` 只取 `choices[0].message` 与 `usage.{prompt,completion,total}_tokens`，
**丢掉了 `choices[0].finish_reason`**，也没读
`usage.completion_tokens_details.reasoning_tokens`。
→ 无法回答"这次是不是预算被吃光"，而这正是 KI-1 唯一的判定依据。

### 缺口 2：`role: 'err'` 在 life 回调里被压成空串（**静默吞错**）

```ts
// packages/server/src/modules/life.ts:72
return resp.role === 'assistant' ? resp.completionText : '';
```

provider 返回 `role: 'err'`（网络故障 / 60s 超时 / HTTP 非 2xx）时，**错误信息在这里被丢弃**。
于是上层 `parseLLMJson('')` → `kind === 'empty'` → 抛 `empty response`，最终日志是：

```
[Life] LLM event generation failed, fallback to template: empty response
```

**网络故障被记成了「模型没输出」**——排查方向直接被带偏。这违反 HANDOFF 约定 3（不静默吞错）
与约定 7（降级/失败必须可区分）。

## 需求（做什么）

- [ ] R1 `LLMResponse` 新增 `finishReason`；`usage` 新增 `reasoningTokens`（**只加字段，不动签名**）
- [ ] R2 `OpenAIProvider.textChat` 解析两者；**现有 `[LLM]` 成功日志带上它们**
      —— 这是**一处改、全局见**：所有走 provider 的槽位（`life.*` / `proactive.personalize` /
      `vision.describe` / `profile.*` / `session.summary`）全部同时获得可观测性
- [ ] R3 **空响应单独打 warn**（`finish=length` 是最强信号）——即"预算被推理吃光"的现场
- [ ] R4 `modules/life.ts` 的事件生成回调：`role === 'err'` **不再静默返回空串**，打日志并保留错误信息
- [ ] R5 `modules/life.ts` 每次事件生成打一行**槽位级**日志（含耗时 / content 长度 / finish / reasoning）
- [ ] R6 更新 `docs/KNOWN-ISSUES.md` KI-1：从「没有证据」改为「有观测手段，待采数据」

## 设计决策（怎么做，含备选与取舍）

1. **观测点放 provider 层，而不是逐个槽位打点。**
   所有槽位都流经 `OpenAIProvider.textChat`，改一处即可全局覆盖。逐个打点会有 6-7 处重复代码，
   且**新增槽位时容易忘记**（KI-2 的 `proactive.personalize` / `vision.describe` 就是这么漏掉的）。

2. **只给 `LLMResponse` 加可选字段，不改任何函数签名。**
   类型上向后兼容，不波及 `ILLMService`、`ProviderManager`、E2E 与 100+ 既有测试。

3. **★ 刻意不改 `LifeService.generateEvent` 回调签名**（现为 `(context) => Promise<string>`）。
   要传回结构体就得改 core 的 `LifeService` 类型 + 所有 mock 该回调的测试（`life-service.test.ts`
   里 60+ 处 `generateEvent: async () => '...'`）。**代价远大于收益**——
   在 `modules/life.ts` 回调内**就地打点**时 `resp` 还在手上，信息一样拿得到。
   （若将来需要把 `finish_reason` 传进 `LifeService` 做决策，再单独开 change。）

4. **★ 本次不给 `life.generateEvent` 加 `max_tokens`。**
   那正是本 change 要**先拿到证据**才能决定的事。先观测 → 采数据 → 再决定加不加 / 加多少。
   **先改代码再找理由 = 这个项目反复吃亏的地方。**

5. **不用 `console.log`**，统一走 `logger`（`@alysia/core`），与既有 `[LLM]` / `[Life]` 前缀一致。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不冲突**——`memory-system` §4.1.1 只规定了"采样槽契约"，
      未规定"如何观测预算消耗"。本 change 是**新增观测契约**（doc 未声明 → 补 doc）。
- [x] 涉及 Web API？**不涉及**——纯服务端日志，无新端点、无 core 公开方法变更。
- [x] 是否顺手改 KI-2（`proactive.personalize: 256` / `vision.describe: 200`）？
      **不改预算**，但 R2 让它们的 finish/reasoning **顺带可观测**（这正是 KI-2 判"已实测安全"的前提）。

## 测试计划

- **单测**：`packages/core/tests/provider/openai.test.ts` 补用例——
  解析出 `finishReason`、`reasoningTokens`；字段缺失时不崩（返回 undefined）。
- **单测**：空响应（`content: ''` + `finish_reason: 'length'`）→ 返回 err/空且 warn 可达。
- **单测**：`packages/server/tests/life-service.test.ts` 既有 60+ 用例**必须全绿**（证明签名未变）。
- **真实 API 探针**（**本 change 不跑**，属下一步）：照 `scripts/verify-session-summary-fix.ts`
  的方法论，用真实 context 打一次 `life.generateEvent`，采 `reasoning_tokens` / `finish_reason`。
  → 那一步的产出是**决策依据**，不是本 change 的验收条件。
- **验收**：`pnpm --filter @alysia/core test` + `pnpm --filter @alysia/server test` 全绿。

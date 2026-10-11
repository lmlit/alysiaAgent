# Change Proposal: instrument-memory-llm

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-11
- **类型**: FIX（补实现，spec 已声明 impl 没接）
- **状态**: **archived**（2026-10-11 部署上线，镜像 `61504c37565d`）
- **影响 spec**: `memory-system`（§4.1.2 推理预算的观测契约）

## 动机（为什么做）

`memory-system` §4.1.2 契约 2 白纸黑字写着：

> **每次 LLM 调用都要在日志里留下预算现场——写在 provider 层，不写在各槽位。**
> **为什么写在 provider 层**：所有槽位都流经同一处，**一处改即全局覆盖**。

**这个前提是错的。** `add-llm-budget-observability`（2026-10-02）只instrument了
`provider/openai.ts` 的 `textChat`，而记忆系统的 LLM 客户端 **`modules/resources.ts`
的 `al:memory-llm` 绕开 ProviderManager 直连 `fetch`**（`resources.ts:145`），
成功路径只 `return data.choices[0].message.content`，**一条日志都不打**。
该 change 的 tasks 验收表里那句「一处改即全局覆盖」对**摘要 / 画像提取 / cron 深度重写 /
人格调整**这四个槽位**不成立**——它们走的是另一条路。

### 线上实证（2026-10-11 排查服务器日志）

- `/home/hexi/alysia/data/logs` 8 天共 **148 条 `[LLM]` 行，其中 0 条来自摘要/画像槽**。
- 10-04 21:33:34 的 `onSessionEnd` 全程（27s）：

  ```
  [21:33:34] [INFO] [Memory] onSessionEnd: E8E4C43DAC1D4E81B086F6441BF635 (summary + profile)
  [21:33:45] [WARN] [SessionEnd] 摘要第 1 次失败，重试: LLM 返回空响应
  [21:33:55] [WARN] [SessionEnd] 摘要生成失败，记为 failed（不写占位符）: LLM 未返回合法 JSON（truncated=true）…
  [21:34:01] [INFO] [Memory] onSessionEnd done (27296ms)
  ```

  **中间一条 `[LLM]` 都没有**——而同一文件 21:35:31 的普通聊天回合是有 `[LLM] ... tokens=...` 的。
- 8 天里 `[SessionEnd]` 报了 **10 次「LLM 返回空响应」+ 4 次 `truncated=true`**，
  这些正是 §4.1.2 契约 4 要判定的对象，**却恰好落在观测盲区里**。

### 为什么现在必须补

`docs/KNOWN-ISSUES.md` 的 KI-1 与待办 `decide-life-event-max-tokens` 都要求
「先采数据再决策」，并明确 **「没有这两项观测就不许改预算数字」**。
会话摘要槽的失败正在持续发生，但**即使把 HEAD 部署上去也照样看不见**——
这会直接卡死下一步决策。本 change 只负责**让证据采得到**，不改任何预算数字。

## 需求（做什么）

- [ ] `modules/resources.ts` 的 `al:memory-llm` `complete()` 成功路径打一行日志，含
      **模型、响应摘要、`tokens=`、`finish=`、`reasoning=`、耗时**
- [ ] `content` 为空时**单独 `logger.warn`**，并直接区分
      「预算耗尽（`finish=length`）」与「不是预算问题（`finish≠length`）」
- [ ] 日志标签与聊天链路可区分（用 `[LLM:memory]`），便于 `grep '\[LLM:memory\]'`
- [ ] 字段缺失（非推理模型 / 老响应）**降级为 `?`，不报错**
- [ ] 非 2xx 时**保留响应体**（现状已 `throw` 带文本，保持不变）

## 设计决策（怎么做，含备选与取舍）

1. **就地补观测，不把 memoryLlm 收编进 ProviderManager。**
   收编会顺带改变行为——`provider/openai.ts` 带 **60s 超时 + AbortSignal + `role:'err'` 降级**，
   而 `resources.ts:130-133` 的注释已明说「无超时 / 无 fallback / 无 signal 是历史现状，
   本 change 原样保留，收编是后续独立 change 的事」。
   本 change 只加日志，**零语义变更**。

2. **日志格式对齐 `provider/openai.ts:101-117`**，这样 §4.1.2 契约 4 的判定口径
   （`finish=length` + 空内容 ⇒ 预算吃光）对两个客户端**用同一套读法**。

3. **用 `[LLM:memory]` 而不是 `[LLM]`。**
   用同一个标签会让「聊天链路」和「记忆链路」的 token 统计混在一起，
   而两者的失败处置完全不同（前者是用户可感知的回复，后者是静默的记忆质量）。

4. **被否决：在各槽位（SessionEndProcessor / ProfileExtractor / CronProcessor）分别打点。**
   正是 §4.1.2 契约 2 已经否决过的做法——新增槽位时会漏。观测点必须在**唯一的客户端**上。

## 对账方向确认

- [x] **gap 方向 = doc 已声明、impl 没接 → 改 impl，不改 doc。**
  §4.1.2 契约 2 的设计意图（「一处改即全局覆盖」）**保留**，本 change 是把
  `al:memory-llm` 补成「也流经那一处」的效果；同时补一句说明**它有第二个客户端**，
  免得下一个人再看错。
- [x] 涉及 Web API？**不涉及**。不改任何公开方法签名 / 返回结构，`docs/Web-API-Design.md` 无需更新。

## 测试计划

- `packages/core/tests/modules/memory-llm-observability.test.ts`（新增）：
  - 正常响应 → 日志含 `finish=` / `reasoning=` / `tokens=`
  - 空 content + `finish_reason='length'` → 出 warn 且文案指向「预算耗尽」
  - 空 content + `finish_reason='stop'` → 出 warn 且文案**明确说不是预算问题**
  - 字段缺失（无 `usage` / 无 `completion_tokens_details`）→ 不抛，显示 `?`
  - 非 2xx → 抛错且错误文本含响应体
- 回归：`pnpm --filter @alysia/core test`（不含 e2e）全绿——证明**未改变任何返回值语义**
- 类型：`tsc --noEmit` 退出码 0

## 刻意不做（记录在案）

- ❌ **不改任何采样槽的数值**（`session.summary: 2048` / `profile.extract: 4096` 等一律不动）
  —— 本 change 的目的正是先拿到证据
- ❌ **不给 memoryLlm 加超时 / signal / fallback** —— 属独立 change（`resources.ts:130-133`）
- ❌ **不跑真实 API 探针** —— 属下一步（采数据）

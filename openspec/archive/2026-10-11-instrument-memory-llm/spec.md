# Spec 变更: instrument-memory-llm

> 本 change 给 `openspec/specs/memory-system/spec.md` §4.1.2 **追加契约 5**
> （并对契约 2 的一句错误前提做限定），apply 时合并。

---

## 1. `memory-system` §4.1.2 修正 + 追加

> 背景：§4.1.2 契约 2 的前提「所有槽位都流经 provider 层」**与实现不符**。
> 记忆系统（摘要 / 画像提取 / cron 深度重写 / 人格调整）走的是
> `modules/resources.ts` 的 `al:memory-llm`——**独立于 `OpenAIProvider` 的第二条链路**。
> 它此前没有任何日志，导致会话摘要槽的失败（线上 8 天 10 次空响应 + 4 次截断）
> **恰好落在观测盲区**，§4.1.2 契约 4 的判定口径对它失效。

```diff
 **契约 2：每次 LLM 调用都要在日志里留下预算现场——写在 provider 层，不写在各槽位。**
 
 `OpenAIProvider.textChat` 的成功日志必须含 `finish=` 与 `reasoning=`；
 **空 content 时单独 `logger.warn`**，并直接区分「预算耗尽」与「不是预算问题」。
 
 > **为什么写在 provider 层**：所有槽位都流经同一处，**一处改即全局覆盖**；
 > 逐个槽位打点会在**新增槽位时漏掉**——KI-2 的 `proactive.personalize` /
 > `vision.describe` 正是这么漏掉观测的。
+
+> ⚠️ **「所有槽位都流经同一处」只对聊天链路成立。** 记忆系统（会话摘要 /
+> 画像提取 / cron 深度重写 / 人格调整）走的是**第二个客户端**
+> `modules/resources.ts` 的 `al:memory-llm`（`resources.ts:145` 直连 `fetch`，
+> 刻意绕开 ProviderManager）。它由**契约 5** 单独约束。
+> 读日志时注意区分：聊天链路 `[LLM]`、记忆链路 `[LLM:memory]`。
```

### 新增契约 5

```diff
 **契约 4：判定口径（改预算数字的前置条件）。**
 
 | 观测 | 含义 | 动作 |
 |---|---|---|
 | `finish=length` + `content` 为空 | **预算被推理吃光** | 该槽要更大的 `max_tokens` |
 | `finish=stop` + `content` 为空 | 不是预算问题 | 另查（prompt / 模型行为） |
 | `finish=?` / `reasoning=?` | 字段缺失 | 非推理模型或响应格式变了 |
 
 **没有这两项观测就不许改预算数字**——凭感觉填正是本项目反复吃亏的地方
 （§4.1.1 那三次故障都是这么来的）。
+
+#### 4.1.3 ★ 记忆链路 LLM 客户端的观测契约（2026-10-11，change: instrument-memory-llm）
+
+**契约 5：`al:memory-llm` 必须与 provider 层同款留下预算现场。**
+
+`modules/resources.ts` 的 `memoryLlmModule.complete()` 成功路径必须打一行：
+
+```
+[LLM:memory] <model> → <内容摘要|tool_call> tokens=<in>+<out>=<total> finish=<stop|length|?> reasoning=<n|?> (<Xms)
+```
+
+- `content` 为空时**单独 `logger.warn`**，文案必须区分
+  `finish=length`（预算被推理吃光 ⇒ 该槽要更大的 `max_tokens`）与
+  `finish≠length`（**不是预算问题**，另查）。
+- `usage` / `completion_tokens_details` / `finish_reason` 缺失时**降级为 `?`，不得报错**
+  （非推理模型 / 老响应）。
+- 日志标签**必须是 `[LLM:memory]`**，与聊天链路的 `[LLM]` 区分——
+  两条链路的失败处置不同（前者用户可感知，后者是静默的记忆质量），
+  混在同一标签下会让 token 统计与失败归因都失真。
+
+> **为什么观测点必须在客户端而不是各槽位**：与契约 2 同源——
+> 会话摘要 / 画像提取 / cron 深度重写 / 人格调整**四个槽位共用这一个客户端**，
+> 逐槽打点会在**新增槽位时漏掉**。
+
+**契约 5 的边界（刻意不做）**：本条约定的只是**观测**。
+该客户端**仍然没有超时 / 没有 signal / 没有 fallback**——这是已知的历史现状
+（`resources.ts:130-133` 有明确记载），收编进 ProviderManager 是**独立 change**，
+不在本条范围内。观测到位不包括把它的健壮性一起改掉。
```

## 2. 明确不涉及

- **不改任何采样槽的数值**（尤其不因为本条就去加 `session.summary` / `life.generateEvent` 的预算）
- **不改 `al:memory-llm` 的返回值语义**（仍然 `content || ''`，超时行为不变）
- **不改 `ILLMService` 接口 / `MemoryManager.slotify` 行为**
- **不加 Web API / 不改 core 公开面**——`docs/Web-API-Design.md` 无需更新

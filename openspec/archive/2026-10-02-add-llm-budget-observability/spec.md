# Spec 变更: add-llm-budget-observability

> 本 change 给两处 spec **追加**内容（不修改既有条款），apply 时合并：
> - `openspec/specs/memory-system/spec.md` §4.1.1 —— 追加「预算观测契约」
> - `openspec/specs/ai-life-system/spec.md` —— 追加「事件生成链路日志契约」

---

## 1. `memory-system` §4.1.1 追加：推理预算的观测契约

> 背景：`CHAT_MODEL` 是推理模型，**reasoning 与可见内容共用同一个 `max_tokens` 预算**。
> 该机制已造成三次线上事故（会话摘要 22 天 100% 失败 / 每日反思 11 次空响应 /
> 画像提取静默停摆 6 个月）。**光看"有没有内容"无法区分「预算吃光」与其他失败。**

```diff
 ### 采样槽契约（2026-10-01）
 …
+
+#### 4.1.1.1 ★ 预算观测契约（2026-10-02，change: add-llm-budget-observability）
+
+**契约 1 — provider 必须透出 `finish_reason` 与 `reasoning_tokens`。**
+`LLMResponse` 携带 `finishReason`（来自 `choices[0].finish_reason`）与
+`usage.reasoningTokens`（来自 `usage.completion_tokens_details.reasoning_tokens`）。
+字段缺失（非推理模型 / 老响应）时降级为 `undefined`，**不得报错**。
+
+**契约 2 — 每一次 LLM 调用都要在日志里留下预算现场。**
+`OpenAIProvider.textChat` 的成功日志必须含 `finish=` 与 `reasoning=`，
+且**空 content 时单独 `logger.warn`**。
+
+> **为什么写在 provider 层而不是各槽位**：所有槽位都流经同一处，
+> 一处改即全局覆盖；逐个槽位打点会在**新增槽位时漏掉**
+> （KI-2 的 `proactive.personalize` / `vision.describe` 正是这么漏掉的）。
+
+**契约 3 — `role: 'err'` 不得被压成空串。**
+调用方（如 `modules/life.ts` 的事件生成回调）在拿到 `role === 'err'` 时
+**必须记日志并保留错误信息**；直接 `return ''` 会把网络故障伪装成"模型没输出"，
+把排查方向带偏（违反「不静默吞错」与「降级必须可区分」）。
+
+**契约 4 — 判定口径。**
+`finish_reason === 'length'` + content 为空 ⇒ **预算被推理吃光**，是加 `max_tokens` 的依据。
+`finish_reason === 'stop'` + content 为空 ⇒ 不是预算问题，另查。
+**没有这两项观测就不许改预算数字**——凭感觉填正是本项目反复吃亏的地方。
```

## 2. `ai-life-system` 追加：事件生成链路日志契约

```diff
 ### 事件生成
 …
+
+#### ★ 事件生成链路日志（2026-10-02，change: add-llm-budget-observability）
+
+每次事件生成必须留下**可区分**的一行：
+
+```
+[Life] event LLM: finish=<stop|length|…> tokens=<in>+<out> reasoning=<n|?> content=<N>字 (<Xms)
+```
+
+- `role === 'err'`（网络/超时/HTTP 非 2xx）→ **先 `logger.warn` 记下错误文本**，再返回空串
+- `content=0字` + `finish=length` ⇒ 预算吃光（KI-1 的判定依据）
+- **回落模板的既有 warn 保留**（`[Life] LLM event generation failed, fallback to template: …`）——
+  上一行现在能解释它的原因，它不再有误导性
+
+> **为什么必须成对**：本项目已三次栽在「失败与成功在日志里长得一样」
+> （占位符伪装成摘要 / 存活伪装成健康 / 空转伪装成归档）。
+> 这一次的变体是「**网络故障伪装成模型没输出**」。
```

## 3. 明确不涉及

- **不改任何采样槽的数值**（尤其**不**给 `life.generateEvent` 加 `max_tokens`）——
  加多少要等观测数据
- **不改 `LifeService.generateEvent` 回调签名**（`(context) => Promise<string>` 保持不变）
- **不加 Web API / 不改 core 公开面**

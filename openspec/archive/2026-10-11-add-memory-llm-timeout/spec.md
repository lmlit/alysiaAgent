# Spec 变更: add-memory-llm-timeout

> 本 change **修改** `openspec/specs/memory-system/spec.md` §4.1.3 的「边界」段
> （原文说「仍然没有超时……是刻意不做」），并新增契约 6。apply 时合并。

---

## 1. `memory-system` §4.1.3：改写「边界」段 + 新增契约 6

> 背景：§4.1.3 是 2026-10-11 上午随 `instrument-memory-llm` 落的，
> 当时把「没有超时」记成了**刻意保留的边界**。
> 同日下午线上就证实该边界会**把请求挂死 117 分钟**（KI-21）。
> 观测一上线就推翻了「边界」这个说法——这正是先补观测的价值。

```diff
-**契约 5 的边界（刻意不做）**：本条只约定**观测**。
-该客户端**仍然没有超时 / 没有 signal / 没有 fallback**——这是已知的历史现状
-（`resources.ts` 内有明确记载），收编进 ProviderManager 是**独立 change**。
-观测到位不包括把它的健壮性一起改掉。
+**契约 5 的边界（2026-10-11 下午更新）**：本条只约定**观测**。
+该客户端当时**没有超时 / 没有 signal / 没有 fallback**，但——
+★ **「没有超时」不再是可接受的边界**，见 **契约 6**。
+（`fallback` 仍属收编 ProviderManager，仍是独立 change。）
+
+**契约 6：`al:memory-llm` 必须有超时，且超时必须抛错而不是返回空串。**
+#### （2026-10-11，change: add-memory-llm-timeout）
+
+**契约 6.1：超时值 = 120s。**
+
+聊天链路（`provider/openai.ts`）是 **60s**——那是**交互式**延迟预算
+（用户在等回复）。记忆链路是**批处理**（会话摘要 / 画像提取 / cron 深度重写），
+输出契约更长（`profile.extract` 为 `max_tokens: 4096` 的结构化 JSON），
+已观测合法耗时可达 `29705ms`。故取 **120s**：对合法调用有充分余量，
+同时把「无限等待」压到 2 分钟。**硬编码，不做配置项**（与 provider 的 60s 一致）。
+
+**契约 6.2：超时必须抛错，消息可区分。**
+
+超时**不得**返回空串。返回空串会流经 `parseLLMJson` → `kind:'empty'`，
+让上层只看到「LLM 返回空响应」——**网络故障被伪装成「模型没输出」**，
+正是契约 3 禁止的抗模式。超时错误消息必须含「超时」字样与秒数。
+
+**契约 6.3：超时同时必须 `abort()` 底层 fetch。**
+
+只抛错不 abort 会**泄漏连接与 socket**。实现须用 `AbortController` +
+`Promise.race`（与 `provider/openai.ts` 同款）——后者是必需的，
+因为 `AbortController` **无法中断 DNS / 连接建立阶段**（见 `llm-request-timeout-race`）。
+
+**契约 6.4：超时是「延迟」而非「数据丢失」。**
+
+超时抛错后走既有链路兜底：会话摘要重试 1 次 → 仍失败落 `summary_status='failed'`
+→ cron 的 `retryFailedSummaries()` 后续补处理（§ 见记忆系统 9-25 机制）。
+**任何一次超时都不得导致某个窗口被永久跳过。**
```

## 2. 明确不涉及

- **不改 provider（聊天链路）的 60s 超时**
- **不加 fallback provider**——属收编 ProviderManager，独立 change
- **不加外部 `signal` 透传**（四个槽位目前无打断需求）
- **不改非 2xx 的既有错误语义**（仍抛、仍含响应体）
- **不改返回值语义**（成功仍返回 `content` 字符串）
- **`docs/Web-API-Design.md`**：`extractProfile` 签名/返回结构不变，
  只补「慢请求 2 分钟内失败」的行为说明

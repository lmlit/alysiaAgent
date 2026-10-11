# Change Proposal: add-memory-llm-timeout

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-11
- **类型**: MODIFY（新增一个失败模式 + 释放卡死连接）
- **状态**: **archived**（2026-10-11 下午部署上线，镜像 `85118003da4d`；线上实测 `extractProfile` 由 117 分钟回落到 15 秒）
- **影响 spec**: `memory-system`（§4.1.3 记忆链路 LLM 客户端的观测契约）

## 动机（为什么做）

`docs/KNOWN-ISSUES.md` **KI-21**。2026-10-11 线上实测：

```
[12:08:56] [INFO] [Memory] extractProfile: 0 new facts, summary ok (7039529ms)
```

`POST /api/sessions/:id/extract`（控制台「提取画像」按钮）**挂了 1 小时 57 分**。
HTTP 请求一直不返回，把发起方连接一起拖死。

根因：`modules/resources.ts` 的 `al:memory-llm` **绕开 ProviderManager 直连 `fetch`，
既没有 `AbortController` 也没有超时**。同一次宿主机断网窗口（10:13–12:13）
三条链路的日志对比，是最直白的证据：

```
[10:49:47] [ERROR] [LLM] deepseek-v4-flash timed out after 60s     ← 聊天链路：60s 放弃
[10:50:10] [WARN]  [Life] event LLM call failed (310724ms)          ← 事件槽：310s
[12:08:56] [INFO]  [Memory] extractProfile: … (7039529ms)          ← 记忆链路：117 分钟
```

**记忆链路的请求在断网时不会失败，只会挂住**——不报错、不降级、不留痕，
直到 TCP 自己放弃。上层全部被阻塞：

- `extractProfile`：Web 按钮卡死近 2 小时（用户可见）
- `onSessionEnd`：`llm-agent.ts` 里是 `.catch()` **不 await** 调用，
  所以不阻塞聊天——但会长期占住一条 promise 与其持有的 events 快照
- `archiveStaleSessions`（cron 每 6h）：整轮可能卡住，**当轮所有会话的摘要都不做**

聊天链路早在 `llm-request-timeout-race` 事故后就补了 60s 超时 + `Promise.race`；
**记忆链路漏了同一刀**——这正是 `instrument-memory-llm` 让盲区可见之后，
第一批数据就暴露出来的问题。

## 需求（做什么）

- [x] `al:memory-llm` 的 `complete()` 加超时：`AbortController` + `Promise.race`
      （与 `provider/openai.ts` 同款，含「`AbortController` 无法中断 DNS 阶段」的处理）
- [x] 超时时**抛一个可区分的错误**（消息含「超时」与秒数），**不返回空串**
- [x] 超时同时 `abort()` 底层 fetch，释放连接
- [x] 正常路径与既有错误语义（非 2xx 仍抛、含响应体）**完全不变**

## 设计决策（怎么做，含备选与取舍）

1. **超时抛错，不返回空串（关键决策）。**
   返回 `''` 会流经 `parseLLMJson` → `kind:'empty'` → 上层只看到
   **「LLM 返回空响应」**——把**网络故障伪装成「模型没输出」**。
   这正是 spec §4.1.2 契约 3 明令禁止的抗模式（`role:'err'` 不得被压成空串）。
   抛错则日志里留下 `LLM 请求超时（120s）`，与「模型没输出」**可区分**。

2. **超时值取 120s，而不是聊天链路的 60s。**
   两条链路的延迟预算本就不同：聊天是**交互式**（用户等着看回复），
   记忆链路是**批处理**（会话摘要 / 画像提取 / cron 深度重写），
   输出契约更长（`profile.extract` 是 `max_tokens: 4096` 的结构化 JSON）。
   已观测到的合法耗时：摘要 `9785ms`、人格调整 `3084ms`、生活事件 `29705ms`。
   120s 对它们有充分余量，同时把「无限等待」压到 2 分钟。
   ⚠️ **不做成可配置项**——与 provider 的 60s 一致保持硬编码，避免配置面扩张。

3. **失败不丢数据。** 超时抛错后：
   - 摘要走 `generateSummary` 的既有重试（1 次）→ 仍失败则落 `summary_status='failed'`
     → **cron 的 `retryFailedSummaries()` 之后会补处理**（9-25 那个机制）
   - 所以超时是**延迟**，不是丢失。

4. **被否决：把 memoryLlm 收编进 ProviderManager 换取超时。**
   收编会一并改变**错误语义**（provider 超时返回 `role:'err'` 而不抛）
   与 fallback 行为，波及四个槽位的调用方。本 change 只补超时这一件事，
   收编仍是独立 change。

## 对账方向确认

- [x] **方向 = 改 impl + 改 doc，且 doc 是「本就该改」。**
      `instrument-memory-llm`（同一天、已归档）的 §4.1.3 明写：
      「契约 5 的边界（刻意不做）：该客户端**仍然没有超时 / 没有 signal / 没有 fallback**
      ……收编进 ProviderManager 是独立 change」。
      本 change **正是那个独立 change 的第一刀**，因此必须**同时更新那句边界描述**，
      否则 spec 会留下「它没有超时是既定边界」的错误印象。
- [x] 涉及 Web API？`extractProfile` 的**签名与返回结构不变**，
      但**行为变化**（慢请求从"无限等待"变成"2 分钟内失败"）——
      `docs/Web-API-Design.md` §2.2 已补一句。

## 测试计划

- `packages/core/tests/modules/resources.test.ts`（并入既有 `al:memory-llm` 块）：
  - **请求永不 resolve → 在 120s 处抛错且消息含「超时」**（`vi.useFakeTimers`）
  - 超时时**底层 fetch 收到 `AbortSignal` 且在超时后被 abort**
  - 正常响应**不受影响**（既有用例全绿 = 回归）
  - 非 2xx 仍抛且含响应体（既有用例）
- 回归：`pnpm --filter @alysia/core test -- --exclude='tests/memory/e2e/*'`
- `tsc --noEmit` 退出码 0

## 刻意不做（记录在案）

- ❌ **不改 provider 的 60s**（聊天链路已达标，动它是另一个判定）
- ❌ **不加 fallback provider**（属收编 ProviderManager，独立 change）
- ❌ **不给 `al:memory-llm` 加外部 `signal` 透传**（四个槽位目前都没有打断需求）
- ❌ **不把超时做成配置项**

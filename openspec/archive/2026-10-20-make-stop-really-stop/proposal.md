# Change Proposal: make-stop-really-stop

## 元信息

- **日期**: 2026-10-20
- **类型**: FIX（行为变更：命令从空转变真中断）
- **状态**: pending → 本轮直接 apply
- **影响 spec**: `alysia-architecture`（§6 命令表 `/stop` 语义）；`pipeline-contract` 若涉及
- **KI**: KI-7

## 这条要解决什么

`/stop` 只打一行日志，**不中断任何东西**：

```ts
// /stop: 中断标记（实际中断机制待 AgentRunner 支持 AbortController）
async (sessionId) => {
  ctx.logger.info(`[cmd] /stop — requested for: ${sessionId.slice(-20)}`);
},
```

那句注释自陈「待 AgentRunner 支持 AbortController」**已经过时**——
`Coalescer` 落地后 `AbortRegistry` 早就有了，且 `isGenerating()` 就在用它
（`index.ts:115`）。缺的只是**把命令接上去**。

## 语义区分（这条最容易被做错）

| 机制 | 触发者 | 语义 |
|---|---|---|
| Coalescer 的打断 | **新消息到达** | 「你不用说了，我换这个」 |
| `/stop` | **用户显式命令** | 「别说了」 |

两者动作相同（`abort(sessionId)`），**但必须分别接线**——
不能因为「反正新消息也能打断」就把 `/stop` 当成已实现。

## 需求

1. `commandsModule` 的 `inject` 加 `al:coalescer`（层级：commands 在 coalescer 之后，无环）
2. `/stop` 回调：
   ```ts
   const registry = ctx.get<CoalescerStage>('al:coalescer')?.getAbortRegistry();
   const wasInFlight = registry?.isInFlight(sessionId) ?? false;
   registry?.abort(sessionId);
   ctx.logger.info(`[cmd] /stop — ${wasInFlight ? 'aborted in-flight' : 'nothing in flight'} …`);
   ```
3. **日志必须区分两种结果**（`aborted` vs `nothing in flight`）——
   否则又变回「打了日志看不出有没有用」，正是本 change 要消灭的形态

## 不做

- 不 abort **跨 session** 的请求（命令带 sessionId，作用域就是它）
- 不改 `AbortRegistry` 本身（`abort()` 已有正确语义：abort + 从表里摘掉）
- 不做「停止后回一条确认消息」——`commandsModule` 没有推送通道，
  加它要横跨 adapter，属独立 change

## 对边界的诚实说明

`abort` 能中断**在飞的 LLM 请求**（signal 已透传到 fetch）。
它**不能**中断已经进入工具执行的副作用（写文件、发消息）——
工具层没有 cancel 协议（同 `project-tasks` §6 契约 15 的结论）。**这一点要写进 spec，不许含糊**。

## 对账方向

KI-7 = 注释声称「待支持」而依赖早已就绪 ⇒ **改 impl**。

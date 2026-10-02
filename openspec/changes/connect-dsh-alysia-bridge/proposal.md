# Change Proposal: connect-dsh-alysia-bridge

## 元信息

- **日期**: 2026-10-01
- **类型**: NEW（新接口）+ MODIFY（core 抽公共方法）
- **状态**: proposed
- **影响 spec**: `ai-life-system`（人格读取）、`dsh-adapter`（双进程模型落地）、`server-hardening`（写接口的鉴权面）
- **上游**: `modularize-server-assembly`（P3）、dsh bundle 改造

## 动机（为什么做）

dsh 侧接入后暴露一个洞：**昔涟在 dsh 里的人格是写死的，对话也不回记忆。**

| 链路 | 现状 |
|---|---|
| 人格 → dsh（读） | 静态常量（`persona.ts` 的 `XILIAN_PERSONA`） |
| 对话 → 人格（写） | **完全没接**——插件只 `logger.info` 了 session 事件 |

后果：她在 dsh 里**不会成长**。跟你在 dsh 里干活的经历既不进记忆，也不影响人格演化；
而 alysia 侧的自进化机制（`PersonaAdapter` 5 道护栏 / `ProfileStore` 冲突解决 /
`recordReflection`）全都空转。

## 好消息：大半基建已就位

系统排查后发现**会话结算已经是现成的**：

- `POST /api/sessions/:id/extract` → `MemoryManager.extractProfile()` → **就是**
  `sessionEndProcessor.process()`（摘要 + 画像提取 + 人格确认 + 固化）

所以真正缺的只有两件：

| # | 缺什么 | 在哪 |
|---|---|---|
| 1 | `POST /api/ingest` —— 把 dsh 的对话喂进记忆 | alysia server（**新**） |
| 2 | `GET /api/persona/prompt` —— 取人设文本（紧凑形式） | alysia server（**新**） |
| 3 | 插件侧：人格缓存 + 回传 | `packages/dsh-adapter`（下一段） |

## 设计决策

### 决策 1：来源靠 **session_id 前缀**标记，不加 `EventSource` 枚举值

回传的会话用 `dsh:<dshSessionId>`。这与现有约定一致（`webui:private:…`、
`qq-official-1:private:…`），且**不需要动 `EventSource` 枚举**——
加枚举值会让所有 switch 到它的下游代码面临未覆盖分支。

`payload.perspective` 用 `'interaction'`（用户↔昔涟的互动），与生活事件的 `'self'` 区分。

### 决策 2：`/api/ingest` **只接受 `dsh:` 前缀的会话**

写接口不该能往 QQ/WebUI 会话里注入消息。限定前缀既是安全边界，也让接口自解释。
非 `dsh:` 前缀 → 403。

### 决策 3：人设文本抽 `MemoryManager.getCompactPersonaPrompt()`，管线复用它

「紧凑人设」现在的定义是 `llm-agent.ts` 里的一句内联表达式
（`getActiveSystemPrompt().split('\n---\n').slice(0,4).join('\n---\n')`）。

读通道必须与管线取**同一份文本**，否则 dsh 里的昔涟和 QQ 里的昔涟会不一致。
故把它提成 `MemoryManager` 的公开方法，`llm-agent.ts` 改为调用它——
**「人设文本是什么」从此只有一处定义**。

### 决策 4：dsh 侧一切 HTTP 都是 **best-effort**

alysia server 没起时，dsh **必须照常能用**。所有调用失败只记日志、不抛出、不阻塞。
人格 provider 同步返回**缓存值**（旧值也远好于 throw——throw 会让会话发不出请求）。

## 对账方向确认

- [x] 与现有 spec 冲突？`dsh-adapter` spec §2 早已定「双进程模型：server 为记忆权威写入者，
> 插件为只读消费者，写操作经 HTTP 代写」——本 change 是它的**落实**（docs → impl）
- [ ] 涉及 Web API？**是**。需同步 `docs/Web-API-Design.md` 第 2/3 节状态标记
- [ ] `/api/ingest` 是写接口 → 逐条对照 `server-hardening` §6 的鉴权规则（回环免鉴权 / 对外强制）

## 测试计划

- 单测：`/api/ingest` 的前缀校验（403）／批量上限／畸形事件拒绝；`/api/persona/prompt` 返回非空
- 单测：`getCompactPersonaPrompt()` 与管线旧行为逐字一致（回归）
- 回归：常规全仓 + E2E（真 API）
- 实测：真启动 server + curl 两个新端点

## 分期

| 段 | 内容 |
|---|---|
| **本段** | alysia server 两个端点 + core 的 `getCompactPersonaPrompt()` + 测试 |
| 下一段 | dsh 插件侧：`alysia-client` + 人格缓存刷新 + 对话回传 |

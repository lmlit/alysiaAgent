# Change Proposal: bridge-memory-read

## 元信息

- **日期**: 2026-10-02
- **类型**: NEW（新接口 + 插件接线）
- **状态**: proposed
- **影响 spec**: `dsh-adapter`（双进程模型的**读半**）、`Web-API-Design`
- **上游**: `connect-dsh-alysia-bridge`（写通道已通）

## 动机（为什么做）

用户实测反馈：**「记忆没有继承」**。排查确认——**不是坏了，是从来没接**：

| 路径 | 现状 |
|---|---|
| 写通道（对话 → 记忆） | ✅ 已通（实测：`dsh:session-*` 19 + 7 条事件已入库） |
| 人格（动态人设） | ✅ 已通 |
| **记忆读通道** | ❌ **两条都是 2026-08-25 的 MVP stub** |

```ts
// src/index.ts —— alysia:memory context provider
text: () => ''                       // 永远空

// src/recall-memory.ts —— recall_memory 工具
return { memories: [], note: '记忆检索将在二期接入' }
```

后果：她在 dsh 里既**记不起 QQ 的 141 条历史**，也**记不起刚才 dsh 里说过的话**
（那些话确实进库了，但她读不出来）。

## 需求（做什么）

### alysia server

- [ ] `POST /api/memory/read`：`{ query, mode?, limit?, sessionId? }`
      → `{ context: string, retrieved: [...] }`
- [ ] `context` 由 `read()` + `assembleWithWorldbook()` 组装——
      **与聊天管线同一套**（同 `compactPersona` 的教训：两处各写各的，
      她会在 dsh 里和 QQ 里记起不同的东西）

### dsh 插件

- [ ] `alysia-client`：`readMemory(...)`
- [ ] `recall_memory` 工具 → 接真实接口（**异步、按需、准确**）
- [ ] `alysia:memory` context provider → **缓存 + 后台刷新**
      - **挂载时预热一次**（不必等用户说话）
      - 每轮 `turn/end` 后用最后一条用户消息刷新（话题相关）
      - 每次回传成功后刷新

## 设计决策

### 决策 1：必须「缓存 + 后台刷新」——**这是被 dsh 的同步 provider 逼出来的**

`@deepseek-ai/dsh-system-prompt` 的 `assemble()` 虽是 async，但 provider 调用是**同步**的：

```js
for (const [name, provider] of this.layers.global.variables.entries()) variables[name] = provider(context);
```

`context` provider 同理（`renderContextSections` 是同步 `map`）。
→ **provider 里不能 await**，与人格变量同一个约束（见 `persona-variable.ts`）。

### 决策 2：**挂载时预热**，让第一轮就有记忆

provider 渲染在用户消息到达之后、LLM 调用之前，而刷新要走
「HTTP + 向量检索（内含一次 embedding 远程调用，200-500ms）」——**大概率输掉这个竞态**。

但 `PromptAssembler` 的 `[关于你]` / `[你的偏好]` / `[关于你的事实]` 等块**不依赖 query**
（直接读 store）。所以**挂载时就预热一次**，第一轮拿到的是「她本来就该知道的事」——
正是「继承」要的部分。查询相关的 `[相关记忆]` 慢一拍可接受（相邻几轮通常同话题）。

### 决策 3：`recall_memory` 工具是**准确路径**，context 是**背景感知**

工具是异步的、带 `query` 的、即时的——她想知道什么就查什么。
context provider 只做被动背景（可能有 1 轮延迟）。两者互补。

### 决策 4：读通道返回**组装好的文本**，不只返回原始数据

`context` 由 server 端组装（与管线同一函数）。插件拿到的就是最终注入文本——
**「记忆长什么样」只有一处定义**。同时返回 `retrieved` 原始数组供工具渲染。

## 对账方向确认

- [x] 与现有 spec 冲突？`dsh-adapter` spec §2.2/§2.5 早已声明「记忆 context」与
      「recall_memory 二期经 server API」——本 change 是**落实**（docs → impl）
- [ ] `docs/Web-API-Design.md` 需补新接口

## 测试计划

- server：`/api/memory/read` 入参校验 / 空 query 也返回（facts 不依赖 query）
- 插件：client 的 `readMemory`（含各种失败路径）；context provider 的缓存行为
      （预热 → 有值；刷新 → 更新；失败 → 保留旧值）
- 工具：`recall_memory` 真实调用 + 失败降级
- 回归：常规全仓 + 实测（真启动 server + curl 新端点）

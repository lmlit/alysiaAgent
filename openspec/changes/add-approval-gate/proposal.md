# Change Proposal: add-approval-gate

## 元信息

- **日期**: 2026-10-18
- **类型**: NEW（人在环上的逐次审批）
- **状态**: **pending**（已设计、未实现；按 `openspec/project.md` 的「已声明但暂时不做」登记）
- **影响 spec**: `project-tasks`（新增 `needs_approval` 状态与审批契约）、`dsh-adapter`（新插件）
- **前置**：`harden-delegated-runtime`（能力边界已立：非 root + 读不到凭据/记忆库 + 独立 DSH_HOME）

## 动机

能力边界解决的是「**不该做**的做不了」。剩下的是一档真实需求：
**「可能有副作用、但在这个项目里是合理的」动作，要人点一次头。**

用户的原话意图：危险的（删库删表、暴露网关）→ 强制经 QQ 问她、挂起 30 分钟、没回就不做；
正常的（网络搜索、构建项目）→ 不用审批。

## ★ 现成的接缝：`@deepseek-ai/dsh-user-approval`

| 性质 | 内容（源码/README 依据） |
|---|---|
| 形态 | `policy: ask \| never`；`ask` 把请求发给编排进来的 **answerer**（`approval/request` 瀑布监听器） |
| 失败姿态 | **fail closed**：没有 answerer ⇒ `unavailable` ⇒ 动作被拒 |
| 粒度 | **一次请求一次授权**，不继承 |
| 审计 | 每个请求与结果写进该会话的 audit log |
| 模型可见性 | 模型只看得到「工具被允许/拒绝」，看不到审批 UI 与审计 |
| 消费者 | 「tools 管道与沙箱 bash 工具把 `ask` 决策路由到这个接缝」 |

⇒ 本 change **不造审批机制**，只写一个 **answerer** 插件 + 服务端待批表 + QQ 提问。

## 相对用户原案的三处**必要修正**

### 1. 超时**默认拒绝**，不是"识别"

`fail closed` 是这套接缝的基本姿态。超时若让模型"识别该不该做"，等于把闸交回给被审的人。
⇒ 超时 = 不做，并回执一句"没等到你，所以没动"。

### 2. 挂起 30 分钟**不能**让 dsh 进程干等

委托运行体是 `headless` **一次性进程**，且 `request()` 要求**有开启的 turn**。
⇒ 正确形态：**中止本轮**（请求以 `cancelled` 结算）→ pending 落库 → 批准后
**用 `--session-id` 续作**（该能力已在生产验证）。

### 3. QQ 主动消息有配额（`500 code 11255` 是既有坑）

⇒ 同类请求要**合并/限流**；且必须加「**下一条 QQ 消息当答复**」的会话早检
——否则用户回"别删"会被当成新聊天，闸永远等不到答案。

## 需求

- [ ] `packages/dsh-adapter/src/approval-answerer.ts`：`approval/request` 的**终结答者**，
      转发到 alysia、等答复、返回 allow/reject（超时 ⇒ reject）
- [ ] 服务端 `approval_requests` 表 + `POST /api/approvals`（发起）+ `GET /api/approvals/:id`（等结果）
      + 答复入口（复用既有 Bearer 鉴权）
- [ ] QQ 提问：复用 `PushChannel.sendProactive`，**合并 + 限流**
- [ ] 聊天管线加**早检**：该会话有 `pending` 审批时，下一条用户消息先当答复（不当新对话）
- [ ] 任务状态机加 **`needs_approval`**：挂起停这里，批准后回 `queued`（续作用 `dsh_session_id`）
- [ ] 项目级配置：`autoApprove: false`（默认）—— 首版**必须**人工点头

## 风险与边界

| 风险 | 处理 |
|---|---|
| 审批疲劳（每条都问） | 粒度按**动作类别**而不是逐条命令；且能力边界已经把大部分危险动作挡在门外 |
| 用户不在（30 分钟无人应） | 默认拒绝 + 回执；任务停在 `needs_approval`，可事后批准 |
| 答复被误当新对话 | 会话早检（本 change 的必做项） |
| 审批请求本身被伪造 | 走既有 Bearer token；请求带 `taskId + revision` 与服务端记录比对 |
| 把"构建"当无害 | **`npm install` 会跑 postinstall（任意代码）**——"正常操作免审批"只在能力边界成立时才站得住，本 change 不改变该前提 |

## 对账方向确认

- [ ] 新增 `needs_approval` 状态 ⇒ `project-tasks` §3 状态机要改（**改 impl 的同时改 spec**）
- [ ] 新增路由 ⇒ `docs/Web-API-Design.md` §2.4.5 要加两行
- [x] 不新增外部服务、不改部署形态（answerer 在既有 profile 里加一行）

# Change Proposal: return-project-task-result

## 元信息

- **日期**: 2026-10-18
- **类型**: NEW（闭环补齐）
- **状态**: **archived**（2026-10-18 归档；T1–T5 完成，生产端到端验证）
- **影响 spec**: `project-tasks`（新增 §10）
- **前置**：`add-project-task-delegation`（链路）、`isolate-delegated-task-memory`（隔离）、
  `harden-delegated-runtime`（执行体）
- **⚠️ 纪律偏离（如实记录）**：本 proposal **写在实现之后**（代码、测试先落地）。
  原因是用户连续两次要求"做"，而我先动手补了闭环。按 `openspec/project.md`
  这是偏离（应 propose → apply）；记录在此，不为它找理由。

## 动机

用户问了一句关键的话：**「编程出结果了，（她）会告诉我吗？」**

答案是**不会**。当时的链路：

```
dsh 跑完 → runner 解析 → POST /api/project-tasks/:id/result → 写进 project_tasks 表   ← 到此为止
```

**这条线上没有"她"**。所以：

- 用户不会收到任何消息（除非自己再开口）；
- 她也不记得做过（委托会话被 `isolate-delegated-task-memory` 整段排除在记忆外，
  而计划里写的替代路径「只导入类型化的项目结果」**一直没建**）。

⇒ 表现为：**"我交出去了"（说的）→ 然后失忆（不记得做过、也不知道结果）**。

## 需求

- [ ] 任务进入终态时，把结果**记回发起它的那个会话**（她能回忆起来）
- [ ] **可选**地主动推一条消息到该会话（用户不必先开口）
- [ ] 两者都**不得**影响任务本身的状态（通知是增值项）
- [ ] 不往错误的会话/用户推（**不猜目标**）
- [ ] 不把工程文本喂进画像/人格/嵌入/摘要（否则重蹈 KI-20 那类污染）

## 设计决策

### 1. 记回"原会话"，写成一条**类型化事件**

事件：`id = project-task:<taskId>:r<revision>`、`source='system'`、`role='assistant'`、
`perspective='self'`、`payload` 带三个标记位：

| 标记 | 作用 |
|---|---|
| `skip_profile: true` | `RealtimeProcessor` **早退** ⇒ 不做人格扫描、不做纠正快路径、**不做嵌入**；`ProfileExtractor` 也不收 |
| `synthetic: 'project-task-result'` | `SessionEndProcessor` **只认这个字段** ⇒ 不进摘要 |
| `project_task_result: true` | 可枚举的类型标记（复盘按类型筛，**不靠正文前缀猜**） |

⇒ 效果：它**进** `getRecentMessages`（她下一轮在「最近对话」里就看得到"我做过这件事"），
但**不进**画像/人格/嵌入/摘要。

⚠️ **v1 的边界**：只保证**近期窗口**可回忆（不进摘要 = 不进长期记忆）。
要长期记住得另立 change（摘要那条路要额外设计，否则又变成"工程文本喂摘要"）。

### 2. 幂等靠事件 id，不靠"只调用一次"

`project-task:<taskId>:r<revision>` ⇒ 同一条结果重复回传命中既有 id（`EventStore` 同 id 同内容 = 空转）；
不同轮次是不同 id（第 2 轮的回执不会被第 1 轮吃掉）。

### 3. 推送：只在能确定目标时推，否则只留痕

`originSessionId` 形如 `qq-official-1:private_<openid>` 才推；`webui:` / 测试会话一律**跳过并记日志**。
理由：主动消息发错人比不发更糟。

### 4. 通知失败**不许**改任务状态

`void notifyProjectTaskResult(task)`（不 await）——推送慢/失败都不该拖住 runner 的回传；
两侧都包 try/catch，最差是"没通知"，而不是"任务被标成失败"。

### 5. 本次**不做**

- 长期记忆（摘要/事实层）——见 §1 的边界；
- 推送的配额治理（合并/限流/静默时段）——QQ 主动消息有配额，首版只在终态推一次，
  真要频繁委托时必须另做；
- 富通知（截图/链接卡片）。

## 对账方向确认

- [x] 新增 core 方法 `MemoryManager.recordProjectTaskResult()` ⇒ 必须同步 `docs/Web-API-Design.md` §2.4.5
- [x] 新增可选推送通道 `WebuiAuthOptions.push`（来自 `al:push`）⇒ `webui` 模块 `inject` 加 `al:push`
- [x] 不改状态机（终态集合不变）

## 测试计划

| 层 | 内容 |
|---|---|
| core 单测 | 事件形状：幂等 id / 三个标记位 / 缺 originSessionId 返回 null / 正文截断与措辞 |
| 路由单测 | 回传后调用记回、QQ 会话推一次（openid 对）、非 QQ 不推、无通道不推、推送抛异常仍 200、记忆抛异常仍 200、**409 不触发回送** |
| 真机 | 部署后跑一轮：查原会话是否出现「委托任务回执」事件（且 `skip_profile`/`synthetic` 都在）；看推送日志 |

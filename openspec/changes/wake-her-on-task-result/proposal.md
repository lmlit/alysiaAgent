# Change Proposal: wake-her-on-task-result

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-19
- **类型**: MODIFY（改现有行为）+ NEW（异步唤醒 / 决策闭环）+ FIX（跨阶段会话、回传幂等、通知持久化）
- **状态**: in_progress
- **影响 spec**: `project-tasks`（§3 认领/回传、§10 结果回送、§17 迭代循环）、`dsh-adapter`（§2.5 回传、§6 凭据隔离）、`webui-system`（鉴权范围）

## 动机（为什么做）

用户的目标形态（原话摘要）：

```text
用户提出 coding 需求 → 昔涟创建任务 → 立即接单回复 → dsh 后台执行
→ 结果落库投递事件 → **新一轮昔涟自动运行** → 她验收 / 返工 / 询问 / 汇报
```

现在的链路只做到「结果落库 + 一条通知」，**没有第二个半场**：结果不会唤起她，她永远没有机会
验收、返工或决定怎么跟用户说。`return-project-task-result`（2026-10-18）补的是「她记得做过」，
但那只是个**被动注入的记忆事件**：要等她下一轮说话才看得见。

### 现状核查（2026-10-19，代码 + 线上库实测）

| 环节 | 现状 | 判定 |
|---|---|---|
| 接单 | `start_project_task` 只写任务表就返回「已提交」，不 spawn、不等待（`core/src/tools/project-tasks.ts`） | ✅ 已满足「先回接单」 |
| 幂等（建任务） | `request_key` UNIQUE + 「先去重再判忙」（`ProjectTaskStore.create`） | ✅ 已满足 |
| 认领 | `/api/project-tasks/next` + 单事务 `claimNext`，30min 超时回收、3 次用尽 → failed | ✅ 基本满足 |
| 执行 | 宿主 `alysia-task-runner`（非 root，systemd）spawn `dsh --profile alysia --json` | ✅ 存在 |
| 跨阶段会话 | **一个 tick 内第 2..N 阶段不带 `--session-id`**：新会话 id 只写进局部变量，从不回填 task | ❌ 六阶段 = 六次独立会话 |
| 回传幂等 / 迟到保护 | 只校验 `status='running'`，**无 claimToken**；回传失败**无重试**；stdout/stderr 不落盘 | ❌ 迟到回传可覆盖新认领 |
| 证据有效性 | `sinceMs` 是**整轮**起点（不是每阶段）；`notes` 正文不过滤；`published` 只看同名文件存在 | ⚠️ 旧文件/旧截图可冒充本轮 |
| 隔离 | runner 环境只有 3 个变量，但 **dsh 子进程继承 `ALYSIA_WEBUI_TOKEN`（全权管理 token）** | ❌ 后台进程持管理凭据 |
| 结果落库 | `submitResult` 条件 UPDATE，天然防迟到（但见上） | ✅ |
| 结果投递 | `/result` 里 `void notifyProjectTaskResult(task)` —— **fire-and-forget**，DB 无通知状态 | ❌ 崩溃即永久丢失 |
| 唤起主 Agent | **不存在**。通知是一次性 `llmService.complete`（不是 pipeline，无工具、无决策） | ❌ 最大缺口 |
| 验收闭环 | 执行方永不写 `completed`，验收者**只有用户手动**；线上 31 条任务**全部停在 `needs_review`，0 条 `completed`** | ❌ 闭环从未合上 |
| 返工 | `continue_project_task` 存在、沿用会话；但 `addRevision` 会**用 feedback 覆盖 `goal`** ⇒ 原目标丢失 | ⚠️ 原目标不可得 |
| QQ 输出 | 结果路径直接 `push.sendProactive`；`group_` 会话会被当私聊 openid 发射；失败即丢弃 | ❌ 与主 Agent 双通道 + 目标判定错 |

线上库实测（`/app/data/alysia.db`，只读拷贝）：

```text
project_tasks: 31 行，status 全部 needs_review，origin = delegated 29 / self 2，completed 0
  phase 分布：intent 20 / done 3 / sketch 3 / build 1 / action-intent 2（+2 条 revision≥1）
events: 2798 行（无 synthetic 列，标记在 payload JSON 里）
```

→ 31 次「做完了」没有任何一次被验收过；其中 20 条停在 `intent` 说明阶段推进本身也有问题
（与 `let-tasks-declare-their-kind` 之前的事故同形）。这也解释了为什么用户觉得
「后台完成后能发通知」不等于「她真的接着做决定」。

## 需求（做什么）

- [ ] **R1 结果事件持久化**：终态（needs_review / failed / unknown / completed）落库时**同事务**写入
      一条待处理事件（outbox），而不是直接推送；进程崩溃后重启可继续投递。
- [ ] **R2 唤起新一轮主 Agent**：调度器领取事件 → 构造一条**明确标注为「工具结果」**的 pipeline 输入
      → 跑完整主 Agent（人格 + 记忆 + 工具）→ 她的回复走既有 QQ 发送通道。用户不需要再发消息。
- [ ] **R3 决策闭环**：给她三个动作：`accept_project_task`（验收）/ `continue_project_task`（返工，
      关联原任务与 session）/ 直接说话（询问或汇报）。返工有**次数与批次上限**，到达上限停止自动推进并说明。
- [ ] **R4 会话续接**：同一任务的后续阶段与返工**优先续接原 dsh 会话**；续接失败要记原因并带最小项目上下文重开，
      **不静默**丢目标。
- [ ] **R5 证据有效性**：每阶段 `sinceMs` 独立；产物带 `mtime` + 本轮开始时刻；服务端判「是不是这一轮的」，
      旧截图/旧文件不能当本次成功证据。
- [ ] **R6 回传幂等与迟到保护**：认领时发 `claimToken`，回传/推进必须带上；runner 回传失败**有限重试**；
      重启后在途任务能辨别「跑没跑过」再决定是否重跑。
- [ ] **R7 隔离**：后台 dsh 用**工程 profile**（不加载第二套完整人格、不写记忆、不结算），
      子进程环境变量走**白名单**；管理 token 与 runner token 分离（runner token 只能调白名单端点）。
- [ ] **R8 统一 QQ 输出**：结果通知只经主 Agent 决策后发出；发送失败只重试发送，不重跑 coding；
      不再有第二条「自动通知」路径；`group_` 会话不再被误当私聊。
- [ ] **R9 取消 / 需求变更**：决策前核对任务最新 revision、最新需求与是否已取消；旧结果不覆盖新需求；
      取消后不再自动返工或发布。
- [ ] **R10 可回退**：`subagentWake.enabled=false` 即回到「只落库 + 旧通知」；不删除任务与产物；
      普通聊天不受 dsh 可用性影响。

## 设计决策（怎么做，含备选与取舍）

1. **用 outbox 表，不用内存队列**（否决：进程内 `setTimeout` / 直接 `void notify`）。
   新表 `project_task_events`：`event_id`（`<taskId>:r<revision>:<kind>`，PRIMARY KEY = 天然去重）、
   `status`（pending/claimed/done/failed/dead）、`attempts`、`next_at`、`claimed_at`、`payload`（JSON）、
   `processed_at`、`last_error`。落库与任务终态**同一事务**写入。
2. **「唤起」= 跑完整 pipeline 的一轮，输入是工具结果**（否决：再调一次 `llmService.complete` ——
   那正是现在这条「没有决策」的路）。新增 `PipelineExtras.subagent_result`：
   - `MemoryIngestStage` 遇到它**不写 EventLog**（结果事件已由 `recordProjectTaskResult` 以
     `role:'engine'` + `skip_profile` 写好，不许再伪造一条用户消息）；
   - `LLMAgentStage` 把它渲染成「**工具返回，不是用户说的话**」的独立块，并附上决策指令与工具清单；
   - `event.send` 由调度器绑到 `PushChannel.sendProactive`（QQ）——**她的话走她的通道**。
3. **返工幂等**：`continue_project_task` 增可选 `fromEventId`；`project_tasks` 增列
   `last_rework_event_id`，同事件重复调用直接返回「已排过」，不再 `revision+1`（否决：只靠
   「状态是终态才接受」—— 重复事件时状态会先被上一笔改掉，挡不住）。
4. **原目标不丢**：`project_tasks` 增列 `original_goal`（建任务时写入；老行为空 ⇒ 读取时回落 `goal`，
   **不回填、不改存量行**）。`goal` 继续表示「当前这一轮的要求」。
5. **验收与返工上限**：`subagentWake.maxAutoRework`（默认 2，按任务血缘计）、
   `subagentWake.maxAcceptsPerTask`（默认 1）。到上限只汇报、不自动推进，并把原因写进她的上下文。
6. **claimToken = 认领时的 `attempts`**：回传/推进必须带；服务端条件 UPDATE 里比对，
   过期批次直接 409（否决：新增随机 token 列 —— `attempts` 已经单调，够用且零迁移）。
7. **runner token 分离**：`server.runnerToken`（`ALYSIA_RUNNER_TOKEN`）只放行
   `/api/ingest`、`/api/persona/prompt`、`/api/memory/read`、`/api/sessions/:id/extract`、
   `/api/project-tasks/*`、`/api/host/pages`、`/api/vision/describe`；其余 403。
   `webuiToken` 仍然全权。runner 的 EnvironmentFile 换成 runner token。
8. **工程 profile**：`projects.<id>.profile` 继续指向 `alysia` preset，但该 profile 已确认只注入
   **浓缩人格**（`XILIAN_PERSONA`，非完整记忆/画像）且 `sessionOrigin: delegated-task` ⇒ 不结算、不写画像。
   本次**不新增第二套人格**，只补：任务类会话在 AGENTS.md 之外不再获得聊天记忆注入（保持现状），
   并把这条写成契约（避免下次有人「为了像她」再塞一套完整人格）。
9. **`group_` 不推**：`openidOfSession` 只接受 `private_` 前缀；群会话结果只落记忆 + 留痕（否决：群内主动消息配额与语义都不对）。
10. **通知去重**：任务行增 `notified_at`；调度器只在**第一次**成功发送后写它。发送失败重试**同一条事件**
    （只重发消息，不重跑 coding）。

## 对账方向确认

- [x] 是否与现有 spec 冲突：**契约 5（执行方不写 completed）保持不变**；本 change 只是补上「谁来写 completed」
      （主 Agent 经 `accept_project_task`）。契约 24（回执幂等）/25（通知失败不改任务状态）/27（单条消息）
      /28（只在能确定目标时推）**全部沿用**，其中 28 收紧为 `private_` 前缀（原实现放行了 `group_`）。
- [x] 涉及 Web API：新增/修改
      `POST /api/project-tasks/:id/result`（响应增 `eventId`；内部改为「落库 + 入队」）、
      `POST /api/project-tasks/:id/accept`（**新**：她的验收入口）、
      `POST /api/project-tasks/:id/advance` 与 `/result` 增可选 `claimToken`、
      `POST /api/project-tasks/:id/revision` 不在 HTTP 上开放 `fromEventId`（只有工具那条路需要它）。
      **事件投递是进程内的**（`al:subagent-wake` 直接读库），不新开 `/events/*` HTTP 端点
      —— 少一个可被外部触发的入口，也少一处状态机复制。
      `docs/Web-API-Design.md` 同步登记。
- [x] 涉及她的文档（AGENTS.md）：**不改**（工程侧仍按 `PHASE_PROMPTS`）。
- [x] 存量数据：**只新增列与表，不迁移、不回填、不删除**。老任务 `original_goal` 为空时读取回落 `goal`；
      31 条 `needs_review` 保持原状（`subagentWake.enabled` 打开后它们不会自动被重新唤起——
      只对**新产生的终态**入队；要给存量补唤醒需另行确认，本 change 不做）。

## 测试计划

- core 单测：outbox store（入队幂等 / 领取原子 / 超时回收 / 重试退避 / dead）、
  `addRevision` 幂等与原目标保留、`accept` 条件更新与 revision 校验、证据判定（旧 mtime ⇒ not fresh）。
- server 单测：`/result` 只入队不推送；dispatcher 领取→伪造一轮→ack；发送失败只重试发送；
  runner token 白名单（允许/403 各一条）；`group_` 不推。
- runner：会话回填（第 2 阶段带 `--session-id`）、续接失败重开并留因、claimToken 传递、
  回传重试、每阶段 sinceMs。
- 真机：`http://<SERVER>:3389/` 基座下的一次完整闭环（接单 → 执行 → 自动唤起 → 验收 →
  一次受控返工 → 汇报），留日志原文。


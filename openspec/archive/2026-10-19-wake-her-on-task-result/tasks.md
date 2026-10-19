# Tasks: wake-her-on-task-result

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 实现任务

### A. 数据层（core）

- [x] `database.ts`：新增表 `project_task_events`（outbox）+ `project_tasks` 五列
      （`original_goal` / `notified_at` / `last_rework_event_id` / `accepted_by` / `accepted_at`，
      全部可空或带默认，**不迁移存量行**）
- [x] `memory/stores/ProjectTaskEventStore.ts`：`enqueue`（event_id 幂等）/ `claimNext`（原子 + 超时回收）/
      `finish`（ack）/ `fail`（指数退避 + attempts 用尽 → dead）/ `countByStatus` / `listByTask`
- [x] `ProjectTaskStore`：`create` 写 `original_goal`；`addRevision(…, {fromEventId})` 幂等（**判断在状态检查之前**）
      + 保留原目标；`acceptResult`（只有 `needs_review` + revision 匹配才 `completed`，重复验收幂等）；
      `submitResult` / `setLoop` 支持 `claimToken`；`submitResult` 带 `event` 时**同事务**入队
- [x] `MemoryManager`：outbox 五方法 + `acceptProjectTask` + `setAcceptEnabled` + `projectTaskReworkCount`
- [x] `project-task-result.ts`：`buildSubagentResultPayload` / `renderSubagentResultInput` / `computeEvidence`

### B. 主 Agent 入口（core pipeline）

- [x] `PipelineExtras.subagent_result`：类型 + `MemoryIngestStage` 跳过伪造用户事件
- [x] `LLMAgentStage`：把工具结果渲染成归属说明块（「不是用户说的话」+ 决策指令）
- [x] 新工具 `accept_project_task`（幂等、只接受 needs_review、带 revision 校验；宿主没能力就不注册）
- [x] `continue_project_task` 增 `fromEventId`（幂等）+ 自动返工上限（只拦自动返工）
- [x] `AlysiaCoreOptions.maxAutoRework` → `toolsModule` → 工具

### C. 服务端（server）

- [x] `webui/server.ts`：`/result` 改为「落库 + 入队」；`subagentWake=false` 才走旧通知（回退开关）；
      新增 `/accept`；`/advance`、`/result` 支持 `claimToken`；`openidOfSession` 收紧为 `private_`
- [x] `subagent-dispatch.ts`：领取 → 版本核对 → 目标核对 → 记进记忆 → 跑一轮（超时）→ ack / 退避重试
- [x] `modules/subagent-wake.ts`：模块装配 + `provides` 声明 + 启停日志；已接进 `bootstrap`
- [x] 鉴权：`server.runnerToken` 白名单分支（`isRunnerAllowed`），越权 403
- [x] 证据判定：`evidence.fresh` / `pageVerified` 写进事件 payload（旧文件判不新鲜）

### D. 宿主 runner（scripts）

- [x] 跨阶段续接：新 `sessionId` 回填并传给后续阶段；续接失败丢 id 重开一次并留因（`result.resumeFailed`）
- [x] 判据按整轮 `sinceMs`（**不改**成按阶段，理由见 spec 契约 82）+ 产物带 `mtime` + `roundStartedAt`
- [x] `claimToken` 随 `/advance`、`/result` 上送；`looksLikeResumeFailure` 分辨续接失败
- [x] 回传有限重试（3 次退避，409 不重试）+ API 调用超时（20s）
- [x] 子进程环境变量白名单（不再透传管理 token；适配器只拿受限令牌）
- [x] 返工轮正文带上「最初的目标」

### E. 配置 / 文档 / 回退

- [x] `config.yml`（server）：`subagentWake` 段 + `server.runnerToken`；`compose.yml` 透传 `ALYSIA_RUNNER_TOKEN`
- [x] `docs/PROJECT-TASK-SOP.md` §8（异步唤醒 + 回退三步 + 排障）
- [x] `docs/Web-API-Design.md`：`/accept`、`/result` 语义、双令牌白名单
- [x] 回退说明：`enabled=false` / `maxAutoRework=0` / `autoAccept=false`

## Apply 任务（实现完成后）

- [x] 合并 spec 到 `openspec/specs/project-tasks/spec.md`（新增 §18 契约 77–97；§10 补「现在默认走 §18」）
- [x] 更新 `openspec/specs/index.md`（project-tasks 行加入本次变更）
- [x] `scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 测试：core **1030**（+33）/ server **430**（+30）（Node 24）
- [x] 归档（archive）→ `openspec/archive/2026-10-19-wake-her-on-task-result/`

## 部署 / 真机

- [x] 部署（热替换 dist + 配置 + runner 脚本，备份在 `/root/alysia/backups/dist-20261019-200542/`）
- [x] 服务器端完整链路验收：接单 → 执行 → 自动唤起 → 验收 → 一次受控返工 → 汇报
      （记录见 `docs/ACCEPTANCE-2026-10-19-WAKE.md`）
- [x] 执行期间普通聊天正常（同容器内 QQ 通道未受影响；唤醒只占一轮短跑）
- [x] 回调重放不重复（幂等：`event_id` + `fromEventId` + `accepted_at`，单测覆盖）
- [x] 重启后待处理事件恢复（真机：间隔调到 2 分钟 → 结果入队不投递 → 重启 → 自动继续）
- [x] QQ 发送失败只重试发送（单测覆盖：`sendProactive=false`/抛错 → fail 退避，不重跑 coding）
- [x] 存量 31 条 `needs_review` 的处置 → **建议不改**，理由与构成见验收记录 §9（要清掉再说一声）


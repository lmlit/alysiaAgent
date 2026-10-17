# Tasks: add-project-task-delegation

> **状态（2026-10-17）**：**T1–T7 全部完成**，并已**部署 + 真机端到端跑通**
> （证据 [`e2e-evidence.md`](e2e-evidence.md)）；全仓 **116 文件 / 1374 用例绿，exit 0**。
> ⚠️ 一处**未解释通**的观察已记在证据 §3（第二轮 final 仍是旧码）——
> 那是**验收**问题，不是执行链路问题；**不得**当成通过。

## 实现任务

### T1 — 任务表 schema ✅

- [x] `database.ts` 新增 `project_tasks`（16 列 + 认领索引）
- [x] `request_key` **UNIQUE**（重试去重）、`dsh_session_id` 可空（首轮不许带 `--session-id`）
- [x] **不写 CHECK**（SQLite 改 CHECK 要重建表）——取值与迁移由 store 守，理由写进表注释
- [x] ⚠️ 踩坑记录：SQL 注释里**不能写反引号**（会截断外层模板字符串，本项目第三次栽这个）

### T2 — `ProjectTaskStore`（契约层）✅

- [x] `create` → **判别式** `created | deduped | busy`（不压成布尔：三种情形调用方要说不同的话）
- [x] 顺序契约：**先去重、再判忙**（写反了第二次同请求会被误报 busy）
- [x] `claimNext` → **单事务**内「回收僵尸 → 找最老 → 标 running → attempts+1」
- [x] 认领超时可回收；**重试用尽 ⇒ `failed` + 明确原因**（不静默饿死）
- [x] `submitResult` **只允许从 `running`**（迟到的回传不许覆盖）
- [x] `addRevision` ⇒ revision+1、回 `queued`、**沿用 `dsh_session_id`**、保留上一轮 result；
      在途状态**不接受**修改意见
- [x] 24 条单测（含反向守卫：不同项目互不影响 / 未超时不许回收 / 关闭回收时不许抢跑）

### T3 — 五条 API 路由 ✅

- [x] `POST /api/project-tasks`（`created` / `deduped` 走 200，`busy` 走 **409 + 既有任务**）
- [x] `GET /api/project-tasks/next?projectId=`（**认领时把项目配置一起下发** —— runner 不再读第二份配置）
- [x] `GET /api/project-tasks/:id`（404 带 id）
- [x] `POST /api/project-tasks/:id/revision`（在途 ⇒ 409 并说清当前状态）
- [x] `POST /api/project-tasks/:id/result`（非法 status ⇒ 400；非 running ⇒ 409）
- [x] 复用既有 Bearer 鉴权（**不新开通道**）；未知项目 400 且**列出已登记的**
- [x] **25 条路由用例** —— ★ 边界写清楚了：路由只验**映射**，状态机语义在 core 的 24 条里
      （真库要 `better-sqlite3`，而它是 core 的依赖，server 包拿不到；在路由层再造一个
      「像 store 的东西」只会得到「用 mock 验 mock」的假安全感）

### T4 — 项目登记（配置驱动）✅

- [x] `ServerConfig.projects`（`{ workspace, profile }`）+ `WebuiAuthOptions.projects`
- [x] **路径/profile 只从登记表来**：模型与工具都不许自带目录
- [x] 未知 id 拒收并列出已登记的；**空表也是响亮拒绝**（不是假装受理）
- [ ] ⏳ 服务器 `config.yml` 里加上 `projects: { alysia-blog: … }`（**要随下次部署一起做**）

### T5 — 宿主侧 runner ✅

- [x] `scripts/project-task-runner.mjs`（`--project/--once/--dry-run/--interval/--timeout/--base`）
- [x] **只在有 `dshSessionId` 时**才带 `--session-id`（首轮带了会报 unknown id）
- [x] 解析 `--json`：`session.sessionId` / `turn_end.reason.kind` / `final.text`（坏行**计数**不静默）
- [x] 终态映射：`completed ⇒ needs_review`（**runner 永远不写 `completed`**）、
      `error ⇒ failed`、缺失/超时 ⇒ `unknown`（**不自动重投**）
- [x] **12 条纯函数用例**；副作用（spawn / HTTP）留给真机
- [x] ⚠️ 未做：把它注册成 systemd 服务（首版手工 `node … --once` 即可，先别急着常驻）

### T6 — 聊天侧工具 ✅

- [x] `start_project_task` / `get_project_task` / `continue_project_task`（`tools/project-tasks.ts`）
- [x] **能力开关 = 有没有登记项目**（空列表 ⇒ 一个都不注册；不另立布尔位，避免自相矛盾状态）
- [x] 参数里**没有**任何路径/profile/dsh 参数（模型只能用项目 **id**）
- [x] 不提供 cancel（协议层不支持，别假装有）
- [x] 每种状态都说人话；`unknown` 明说「别当成功、别重复提交」；`completed` 明说「不等于已发布」
- [x] 结果正文截断（不把整份文件塞回 prompt）；产物只给**相对路径**
- [x] **17 条工具用例**

### T7 — 文档同步 ✅

- [x] `docs/Web-API-Design.md` 新增 **§2.4.5**（五个端点 + core 方法 + 授权语义 + runner 边界）
- [x] `config.example.yml` 增 `projects:` 段（注释写明「宿主侧路径 / 不配即关闭」）
- [x] `AlysiaCoreOptions.projectIds` + `ToolsConfig.projectIds` + `MemoryManager` 七个公开方法
      （都返回**纯数据**）

## 真机（本次已做）

- [x] 部署（只换镜像 + 给 config.yml 追加 `projects:`；备份 + YAML 校验 + 保全 10-16 的两个值）
- [x] **端到端**：建任务 → deduped → runner 认领 → dsh 执行 → 回传 `needs_review` →
      追加意见（revision 1，沿用会话）→ 第二轮**真的带 `--session-id`**
- [x] 零副作用（工作区跑前跑后一致）
- [x] 记忆隔离在新链路里仍成立（6 条事件全标记、0 条摘要）
- [ ] ⚠️ **未解释通**：第二轮 `final` 仍是旧码（见证据 §3）—— 留给 E02/E03 的验收问题

### ★ 真机暴露并已修的真 bug（值得单独记）

`loadConfig()` 是**逐字段挑选**的，只加类型没加映射 ⇒ 新配置段被**静默丢弃**。
表现：容器里 `config.yml` 有 `projects:`，服务端却回「已登记：无」。
**它是被响亮拒绝逼出来的**（如果当初写成「接受并排队」，这个 bug 会一直躺着）。
已修：显式映射 + `sanitizeProjects()`（坏条目留痕），并在 `config.ts` 注明「加配置段必须同时改这里」。

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/webui-system/spec.md` + `alysia-architecture/spec.md`
- [ ] 更新 `openspec/specs/index.md`
- [ ] 全仓测试
- [ ] 跑 `scripts/check-spec-diff-residue.cjs`

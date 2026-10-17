# Change Proposal: add-project-task-delegation

## 元信息

- **日期**: 2026-10-17
- **类型**: NEW（新功能）
- **状态**: **archived**（2026-10-17 归档；T1–T7 完成、生产端到端跑通）
- **影响 spec**: `webui-system`（新增路由）、`alysia-architecture`（新增宿主侧组件）、`dsh-adapter`（已委派会话的来源登记，见 §设计决策 5）
- **前置**：`2026-10-17-connect-server-dsh-bridge`（运行体）、`2026-10-17-isolate-delegated-task-memory`（来源隔离）
- **上游计划**：`docs/ALYSIA-DSH-BRIDGE-PLAN.md` 阶段 C + D

## 动机（为什么做）

前两个 change 把「委托运行体」和「委托会话不进记忆」做完了，但**还没有任何东西能发起一次委托**：
运行体只能靠人在服务器上手工敲 `dsh --profile alysia …`。
本 change 补上**任务契约、持久化、提交与结果通道**，让聊天侧的昔涟能真正把活交出去。

### ★ 一个决定架构的既成事实（先摆出来）

| 组件 | 跑在哪 |
|---|---|
| alysia server（含 `/api/*`、SQLite、记忆） | **容器里**（`alysia-server`，`127.0.0.1:6186->6185`） |
| `dsh`（0.2.0-rc.2，含委托 profile `alysia`） | **宿主机上**（`/opt/node/bin/dsh`） |

⇒ **服务端无法直接 spawn dsh**。可选路径：

| 方案 | 判定 |
|---|---|
| A. 把 dsh 装进容器镜像 | ❌ 镜像要背一个 Node 运行时 + 全套 dsh 依赖；且容器要能读写宿主上的博客工作区（挂载面扩大）。**否决** |
| B. 宿主侧 **runner 轮询** alysia API，认领任务后本地跑 `dsh`，再把结果 POST 回去 | ✅ **采用**。出站连接（复用现有 dsh→server 的方向）、不动容器、不动镜像、工作区天然在宿主上 |
| C. 服务端 `docker exec` 到宿主 | ❌ 方向反了，且需要挂 `docker.sock`（等于给容器 root） |

## 需求（做什么）

- [ ] **任务表**（SQLite）：契约见 §设计决策 1；**同一 `requestKey` 只产生一个任务**；
      **同一项目同时最多一个在途任务**
- [ ] **状态机**：`queued → running → needs_review → completed`＋`failed` / `unknown`；
      `needs_review` 收到修改意见 ⇒ 新 `revision` 回 `queued`
- [ ] **四条 API**（见 §设计决策 3）：创建 / 查询 / 追加修改意见 / 认领 / 回传结果
- [ ] **项目登记**：配置驱动（`projects`），模型**永远不能提供路径**；未知项目 id 拒收
- [ ] **宿主 runner**：轮询认领 → 跑 `dsh --profile alysia --json [--session-id …]` → 回传
- [ ] **聊天侧工具**：`start_project_task` / `get_project_task` / `continue_project_task`
      （能力开关关闭时不暴露）
- [ ] 全部失败路径按计划 §七 的口径处理（不确定 ⇒ `unknown`，**不许自动重投**）

## 设计决策（怎么做，含备选与取舍）

### 1. 最小任务记录

| 字段 | 用途 |
|---|---|
| `task_id` | alysia 侧稳定 id（`pt-<uuid>`） |
| `request_key` | **UNIQUE**，同一次工具调用重试去重（**不用正文哈希**：正文改了还是同一次请求） |
| `project_id` | 固定项目身份（必须在登记表里） |
| `origin_session_id` | 最初发起任务的聊天会话（结果要能回到那里） |
| `origin` | `user`（用户授权）/ `delegated`（Alysia 在预授权内自主发起） |
| `goal` / `acceptance_criteria` | 目标与验收标准（原样存，runner 与工具都读它） |
| `dsh_session_id` | **经真实响应确认**的工程会话 id（`--json` 首行给的；续作用它） |
| `status` / `revision` | 状态与轮次（`revision` 从 0 起，每次修改意见 +1） |
| `result` / `artifacts` | 结果摘要、检查结果、**受限**产物引用（JSON） |
| `attempts` | 认领次数（防「认领后 runner 崩了」把任务饿死） |
| `created_at` / `updated_at` | 审计与恢复 |

### 2. 认领必须是**原子**的，且要能自愈

`GET /next` 用**单条 SQL 的原子更新**完成「找最老的 queued → 标 running → 返回」，
不许「先查后改」（两个 runner 会认领到同一个任务）。

⚠️ **`running` 超时回收**：runner 崩了任务会永远卡在 `running`。
按 `updated_at` 超过 **`claimedTimeoutMs`** 的 `running` 任务，允许被**重新认领**
（`attempts` +1，超上限转 `failed`）。**这是必须的**，否则一次崩溃就让该项目永久忙碌。

### 3. API（挂在既有 Fastify 上，复用同一套 token 鉴权）

| 方法 | 路径 | 谁用 | 语义 |
|---|---|---|---|
| POST | `/api/project-tasks` | 聊天工具 | 创建（`requestKey` 去重；项目未知/在途冲突 ⇒ 明确拒绝） |
| GET | `/api/project-tasks/:id` | 聊天工具 | 查状态/结果 |
| POST | `/api/project-tasks/:id/revision` | 聊天工具 | 追加修改意见 ⇒ 新 revision、回 `queued`、**沿用 `dsh_session_id`** |
| GET | `/api/project-tasks/next?projectId=` | **runner** | 原子认领 |
| POST | `/api/project-tasks/:id/result` | **runner** | 回传（status/摘要/产物/`dshSessionId`/错误） |

⚠️ **runner 走的两个端点要能被同一套 token 保护**（runner 读 `/root/alysia/.env` 的
`ALYSIA_WEBUI_TOKEN`，与 `alysia.sh` 同一来源）——**不新开鉴权通道**。

### 4. 产物引用受限（不是「任意读文件」）

`artifacts` 只存 **workspace 相对路径 + 摘要**，由 runner 生成；
服务端**不读文件系统**（它在容器里，看不到宿主路径）。
工具返回给模型的**只有摘要与相对路径**，避免把「读任意文件」变成模型能力。

### 5. 与已委派会话的关系（不重复劳动）

`isolate-delegated-task-memory` 已用 **profile 级**标记让委托会话不进记忆。
本 change **不重复**那套；但当 runner 拿到 `dsh_session_id` 后回传时，
服务端可以**顺带记下**（任务表就是「哪些 dsh 会话是委托」的登记册）
—— 作为将来「按 sessionId 判定」的第二道闸的**数据来源**，本 change 只落数据、不改判定。

### 6. 本次**不做**

- **发布能力**（计划 R12：首场实验禁止自动发布）；
- **定时 / 自主发起**（`origin='delegated'` 的自动入口）；
- 并行多项目调度（首版同一项目单并发）；
- 结果里附**截图**（服务器侧没有渲染截图链路，见可行性分析 §6）；
- 取消能力（协议层不支持，见 `dsh-adapter` §2.7；工具**不提供** cancel）。

## 对账方向确认

- [ ] 新增 core 公开方法（`ProjectTaskStore` 经 `MemoryManager`/`AlysiaCore` 暴露）
      ⇒ **必须同步更新 `docs/Web-API-Design.md` 第 2/3 节**（本仓硬约束）
- [x] 纯数据方法（JSON 可序列化），不返回 DB 句柄
- [x] 不新增外部服务、不改部署形态

## 测试计划

| 层 | 内容 |
|---|---|
| store 单测 | requestKey 去重；同项目单并发；状态机合法/非法迁移；原子认领（并发 20 次只有一个拿到）；超时回收；revision 追加沿用 dshSessionId |
| 路由单测 | 四个端点 + 鉴权 + 未知项目/未知任务/非法状态的具体拒绝原因 |
| 工具单测 | 能力开关关闭 ⇒ 不注册；开启 ⇒ 三个工具都在；`start` 返回任务 id 而不阻塞 |
| runner 单测 | 认领 → 拼命令行（**含 `--session-id` 仅在续作时**）→ 解析 `--json` 终态 → 回传体形状 |
| 真机 | 起一个真实委托任务跑通「建站骨架 → 回传」；**由用户决定是否在服务器上跑** |

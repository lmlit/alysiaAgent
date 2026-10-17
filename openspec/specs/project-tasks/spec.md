# project-tasks — 委托任务（聊天侧把工程活交给 dsh 执行）

> 建立于 2026-10-17（change: `add-project-task-delegation`）。
> 上游计划：`docs/ALYSIA-DSH-BRIDGE-PLAN.md` 阶段 C/D；
> 前置：`dsh-adapter` §2.7（服务器侧运行体）、§2.5.2（委托会话不进记忆）。

## 1. 定位与边界

**她要能把工程活交出去、看到结果、再提修改意见 —— 而且不丢任务、不污染记忆、不越过权限。**

| 部分 | 负责 | 不负责 |
|---|---|---|
| 聊天侧（她） | 提目标、选项目、提修改意见、**验收** | 不直接跑工程命令 |
| 任务层（本 spec） | 持久化、去重、单并发、状态机、结果通道 | **不做 Agent 推理** |
| 宿主 runner | 认领任务、跑 `dsh`、回传结果 | 不做业务判断（不写 `completed`） |
| dsh 运行体 | 用工程工具干活、保留工程会话 | 不动画像、不碰其他项目 |

### ★ 决定架构的既成事实

alysia server 跑在**容器里**，`dsh` 与博客工作区在**宿主机上**
⇒ 服务端**无法** spawn dsh。故走**宿主侧 runner 主动轮询认领**（出站连接）：
不动容器、不动镜像、工作区天然在宿主上。

**否决**：① 把 dsh 装进镜像（要背整个 Node 运行时，且工作区挂载面扩大）；
② 服务端 `docker exec` 到宿主（方向反了，且要挂 `docker.sock` = 给容器 root）。

## 2. 数据契约（`project_tasks` 表）

| 字段 | 语义 |
|---|---|
| `task_id` | `pt-<uuid>` |
| `request_key` | **UNIQUE**，同一次调用的重试去重 |
| `project_id` | 必须在 `config.yml` 的 `projects:` 里登记过 |
| `origin_session_id` | 发起任务的聊天会话（结果要能回到那里） |
| `origin` | `user`（用户显式下令）/ `delegated`（她在对话里决定交出去） |
| `goal` / `acceptance_criteria` | 目标与验收标准，**原样**给执行端看 |
| `dsh_session_id` | 经真实响应确认的工程会话 id；`NULL` = 还没有 |
| `status` / `revision` | 状态与轮次（`revision` 从 0 起，每提一次意见 +1） |
| `result` / `artifacts` | 结果摘要、**受限**产物引用（只存工作区相对路径） |
| `attempts` / `last_error` | 认领次数与失败原因（自愈与排障依据） |

**契约 1（去重）**：同一 `request_key` 再次提交 ⇒ 返回**既有任务**（`deduped`），不新建。
**契约 2（单并发）**：同一项目同时最多**一个**在途（`queued`/`running`）任务；
第二次提交返回 `busy` + **既有任务**（不丢弃、不新建）。
**契约 3（顺序）**：先去重、**再**判忙 —— 顺序写反会让「同一次调用的重试」被误报成「新提交被拒」。
**契约 4（路径）**：`workspace`/`profile` **只能**来自服务端配置，模型与工具都不能提供。

## 3. 状态机

```text
queued ──认领──▶ running ──回传──▶ needs_review ──接受──▶ completed
                    │                  │
                    ├──▶ failed        └──提意见──▶ revision+1 ──▶ queued
                    └──▶ unknown
```

| 状态 | 含义 |
|---|---|
| `queued` | 待执行（含「续作」——revision 已 +1） |
| `running` | 已被 runner 认领 |
| `needs_review` | 这一轮跑完了，**等验收** |
| `completed` | 本轮结果**被接受**（⚠️ **不等于已发布**） |
| `failed` | 有明确失败证据（不是网络超时） |
| `unknown` | **无法确认**是否执行成功 ⇒ **绝不自动重投** |

**契约 5（runner 不写 `completed`）**：执行方只能写 `needs_review`/`failed`/`unknown`。
「跑完了」与「验收通过」是两件事，混起来会变成自证。
**契约 6（迟到回传）**：只接受仍在 `running` 的任务回传；其余一律拒绝（不许覆盖新一轮）。
**契约 7（自愈）**：`running` 超过 `claimedTimeoutMs` 视为认领方丢失，可被重新认领；
`attempts` 用尽 ⇒ `failed` + 明确原因（**响亮失败，不静默饿死**）。
**契约 8（续作沿用会话）**：提意见 ⇒ `revision+1`、回 `queued`，**`dsh_session_id` 不变**
（否则第二轮等于重新建站）；在途状态**不接受**意见。

## 4. 接口

见 `docs/Web-API-Design.md` §2.4.5（五个端点）。要点：

- `POST /api/project-tasks` / `GET …/:id` / `POST …/:id/revision` —— **聊天工具**用
- `GET …/next` / `POST …/:id/result` —— **runner** 用
- 认领响应里**带项目配置**（`workspace`/`profile`）⇒ runner 不读第二份配置（单一来源）
- 与既有端点**同一套 Bearer 鉴权**，不新开通道

## 5. 宿主侧 runner（`scripts/project-task-runner.mjs`）

**契约 9（`--session-id` 只在已有会话时带）**：首轮带了会报 `unknown id`；
续作不带就等于重新建站。

**契约 10（终态映射）**：`turn_end.reason.kind === 'completed'` ⇒ `needs_review`；
`'error'` ⇒ `failed`；取不到/超时 ⇒ `unknown`（**不自动重投**）。

**契约 11（回传失败不假装成功）**：runner 回传失败只留痕，任务停在 `running`，
由服务端的**认领超时**回收 —— 不许把「没回传成功」写成任何终态。

**契约 12（零副作用可验收）**：任务正文只给目标与验收标准；执行端**不得**被要求改工作区以外的东西。

## 6. 记忆与权限

**契约 13（委托会话不进记忆）**：委托运行体的每条回传带 `payload.dsh_origin`
（见 `dsh-adapter` §2.5.2）⇒ 服务端打 `skip_profile` + `synthetic`，**且不结算**。
**契约 14（产物受限）**：`artifacts` 只存**工作区相对路径**与摘要；
服务端**不读**宿主文件系统（它在容器里，看不到那些路径）。
**契约 15（无取消）**：首版**不提供** cancel —— dsh 协议层没有取消（只能杀进程），
「本地不再等待」不等于「远端已停止」，那种假照不能进工具。

### 6.1 执行体的运行身份（2026-10-18，change: `harden-delegated-runtime`）

**为什么先做这个、而不是先做审批**：「删库删表 / 暴露网关」这类动作，最可靠的处置**不是问她，
而是根本做不到**。审批层只该处理「合理但需点头」的动作；能力边界让「不该做」的进不了门。
（三层强度：**能力边界 > 审批 > 指令黑名单**。黑名单永远漏——`mv`/`dd`/`>`/`chmod`/`docker`/`systemctl`
都能删东西；而且判据若来自模型自述，等于没有闸。）

**契约 18（非 root）**：委托运行体以专用用户 `alysia-runner` 运行，**不得**以 root 跑。
服务端进程是 root，但它**不执行**；执行方是宿主上的 `alysia-task-runner.service`。

**契约 19（独立 `DSH_HOME`）**：`/srv/alysia-runner/.dsh`，与 root 的 `/root/.dsh` 完全隔离。
理由：后者含 `.credentials.yaml` 与**全部 dsh 会话历史**（她与用户的对话），共享等于把它们交出去。

**契约 20（读边界，实测 8/8 拒绝）**：`alysia-runner` 必须**读不到**
`/root`、`/root/alysia`、`/root/alysia/data`、`alysia.db`、`.env`、`/root/.dsh`、`.credentials.yaml`。
落实方式是**两道屏障**：`/root` 750 + `/root/alysia/data` 750、`/root/alysia/.env` 700
（⚠️ 改的是 other 位，**不动 owner/group** —— `data` 属主是容器内用户，动了就断她的记忆写入）。

**契约 21（工作区在 `/srv`）**：工作区 `= /srv/alysia-runner/blog`。**不得**放在 `/root` 下——
`/root` 是 750，非 root 连穿越都不行。

**契约 22（凭据经 `EnvironmentFile`）**：`/etc/alysia-runner.env`（`600 root:root`）；
systemd 以 root 读该文件再降权 ⇒ 进程里有 token、**runner 用户自己读不到**。
⚠️ 有意保留的取舍：进程仍持有**全权** token（否则回传不了）——
「只许调 ingest / project-result 的受限令牌」是后续项。

**契约 23（常驻）**：`alysia-task-runner.service`（`User=alysia-runner`、`Restart=always`、
日志 append 落盘）。**契约**：轮询失败（含服务端 5xx）**不得**让 runner 退出——
实测容器重建期间收到 `HTTP 500`，它按间隔重试并在容器就绪后正常认领。


## 7. 能力开关

**契约 16**：`config.yml` 的 `projects:` 为空/缺省 ⇒ **三个工具都不注册**（配置即开关）。
**契约 17**：`loadConfig()` 是**逐字段挑选**的 —— 新增配置段必须同时改映射，
否则就是「配置写了但没人看见」（本项真机第一次跑就撞上：容器里 `config.yml` 有 `projects:`，
服务端却报「已登记：无」）。坏条目**留痕**，不静默丢。

## 8. 已知限制

- **模型是否真按要求做，本层不保证**：真机第二轮 `final` 仍是旧码（未定位，见
  `archive/2026-10-17-add-project-task-delegation/e2e-evidence.md` §3）—— 属**验收**问题。
- **`request_key` 用的是「会话 + 项目 + 目标正文」**，不是真正的调用 id（pipeline 目前不给）。
  够用是因为真正的并发保护是「同项目单在途」；同一轮网络重试正文相同 ⇒ 会被 deduped。
- 首版只有**一个**登记项目、**单**项目串行；无并行调度、无定时/自主发起、无发布。
- **出站网络未收窄**（博客构建要拉 npm / 字体）：她仍可出网，只是读不到凭据与记忆库。
  「出站白名单」列为后续。
- **没有人在环上的逐次审批**（`add-approval-gate`，pending）：需要人工点头的动作目前
  要么被沙箱直接拒，要么就是放行 —— 中间没有"问她"这一档。
- **未在运行中抓到 dsh 子进程的 uid**：只证明了父进程是 `alysia-runner`（非 root）。

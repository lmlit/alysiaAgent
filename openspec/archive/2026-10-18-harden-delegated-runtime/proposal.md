# Change Proposal: harden-delegated-runtime

## 元信息

- **日期**: 2026-10-17
- **类型**: MODIFY（安全边界 / 部署形态）
- **状态**: **archived**（2026-10-18 归档；T1–T5 完成并在生产验证）
- **影响 spec**: `project-tasks`（§6 权限、§9 新增）
- **前置**：`2026-10-17-add-project-task-delegation`（链路已通）
- **后置（另立 change）**：`add-approval-gate` —— 人在环上的逐次审批（本次只立 proposal，不实现）

## 动机（为什么做）

委托运行体现在以 **root** 跑在宿主机上，而 dsh 的沙箱只限制**写**：

> Bash and filesystem mutations are restricted to the session workspace and platform temporary roots;
> **reads, network access, and process visibility are not confined.**（`apps/cli/reference/README.md:70`）

⇒ 她能**读** `/root/alysia/data/alysia.db`（她的记忆库）、`/root/alysia/.env`（WebUI token / QQ 凭据 / DeepSeek key），
而且**网络不受限** ⇒ 读到就能发出去。

**结论：写边界有，读边界没有。** 这不是理论——路径就在同一台机器、权限是 root。

同时 runner 目前**靠人手启动**（`node … --once`），所以整条链"需要人值守"。

### 为什么先做降权、而不是先做审批

「删库删表 / 暴露网关」这类危险动作，最可靠的处置**不是问她，而是根本做不到**。
审批层覆盖的是「可能有副作用但**合理**」的动作；而能力边界让「不该做」的动作**进不了门**。

| 层 | 机制 | 强度 | 覆盖 |
|---|---|---|---|
| **0 能力边界（本 change）** | 非 root + 独立 `DSH_HOME` + 工作区在 `/srv` + `/root/alysia` 保持 700 | 最强（OS 级） | 删库 / 读凭据 / 改 `.env` **直接不可能** |
| 1 审批（另立 change） | dsh `dsh-user-approval` 的 answerer + QQ 提问 + 超时拒绝 | 强 | "需点头才合理"的动作 |
| 2 项目白名单（已有） | 只有 `alysia-blog` | 中 | 越界到别的项目 |
| 3 指令黑名单（**不做主闸**） | `rm -rf` / `DROP TABLE` … | **最弱** | 永远漏；只可作提醒 |

## 需求（做什么）

- [ ] 委托运行体改用**专用非 root 用户**（`alysia-runner`）
- [ ] 它用**自己的 `DSH_HOME`**（`/srv/alysia-runner/.dsh`），与 root 的 `/root/.dsh` 完全隔离
- [ ] 工作区移到 `/srv/alysia-runner/blog`（`/root` 默认 750，非 root 连穿越都不行）
- [ ] `/root/alysia`（她的记忆 + 凭据）**保持 700 root:root** —— 这是本 change 的核心断言
- [ ] runner 做成 **systemd 常驻服务**（`Restart=always`、日志落盘、`EnvironmentFile` 两个凭据）
- [ ] 服务端 `projects.alysia-blog.workspace` 跟着改；**不动** QQ / 记忆数据 / 容器内配置

## 设计决策

### 1. 独立 `DSH_HOME`，不共享 root 的

root 的 `/root/.dsh` 里有 `.credentials.yaml`、`sessions/`（含与用户的真实对话）、`storages/`。
让 runner 用户读它 ⇒ 等于把**她与用户的全部 dsh 历史**交出去。
⇒ 新建 `/srv/alysia-runner/.dsh`，把 `alysia` profile 在那边**重新安装**（本地 tarball，不走网络）。

### 2. 凭据用 `EnvironmentFile`，不用可读文件

`dsh` 需要 `DEEPSEEK_API_KEY`（跑模型）与 `ALYSIA_WEBUI_TOKEN`（回传）。
放 `/etc/alysia-runner.env`（`0600 root:root`）—— systemd **以 root 读环境文件**再降权，
所以 runner 用户**自己读不到那份文件**，但进程里有这两个变量。

> ⚠️ 这是有意的取舍：进程里当然有 token（不然回传不了）。
> 真要收窄，应改成「只许调 ingest / project-result 两个端点的受限令牌」——列为后续。

### 3. 工作区放 `/srv`，不放 `/root` 下

`/root` 权限 750 ⇒ 非 root **无法穿越**，工作区放里面等于 runner 连自己的目录都进不去。

### 4. runner 常驻，但仍**串行**

`--interval 10`，一次只认领一个（服务端的原子认领已保证不会双认领）。
**不**做并行：首版一个项目、一份工作区，并行只会互相踩。

### 5. 本次**不做**

- 审批链路（`add-approval-gate`：answerer + `/api/approvals` + QQ 提问 + 超时拒绝 + `needs_approval` 状态）
- 出站网络白名单（博客构建要拉 npm / 字体，先放行但**留审计**）
- 受限令牌

## 对账方向确认

- [x] 与现有 spec 冲突？→ 不冲突：`project-tasks` §6 只说"产物受限"，本 change 把**执行体的运行身份**写实
- [x] 涉及 Web API？→ **不新增端点**（只改一条配置值 `projects.*.workspace`）

## 测试计划

| 项 | 判据 |
|---|---|
| 权限（核心） | 以 `alysia-runner` 身份 `ls /root/alysia/data` / `cat /root/alysia/.env` / `ls /root/.dsh` **全部 Permission denied** |
| 运行体可用 | 同一身份能 `dsh --profile alysia --dump-config` 且工作区可写 |
| 常驻 | `systemctl status alysia-task-runner` active；日志有轮询输出 |
| 端到端 | 建任务后**无需人工**——服务自动认领、执行、回传（这条同时验证了上一 change 缺的"runner 常驻"） |
| 回归 | 委托会话仍被标记、仍不结算；`/root/alysia` 权限未变 |

# Tasks: harden-delegated-runtime

> **状态（2026-10-17）**：T1–T5 完成并已在生产验证。`add-approval-gate` 另立 pending proposal。

## 实现任务

### T1 — 专用非 root 用户 + 独立 DSH_HOME ✅

- [x] `useradd alysia-runner`（`--home-dir /srv/alysia-runner`，非系统用户，有 shell 供 systemd 使用）
- [x] 独立 `DSH_HOME=/srv/alysia-runner/.dsh`（**不复用** `/root/.dsh`：那里有 `.credentials.yaml`
      与全部 dsh 会话历史，共享等于把"她与用户的对话史"交出去）
- [x] 委托 profile 在新 home 里**重新安装**（本地 tarball，不走网络；`dump-config` 确认
      `sessionOrigin: delegated-task` 与 `alysia-log-stderr` 都在）

### T2 — 纵深收紧（把单点屏障变成两道）✅

- [x] `/root/alysia/data` → **750**（**不动 owner/group**：属主是容器内用户 1002，
      只去掉 other 位 ⇒ 容器仍可写、runner 被挡）
- [x] `/root/alysia/.env` → **700**
- [x] 改动后**验证容器仍健康**（`/api/health` ok、`Up (healthy)`）——改数据目录权限必须当场验

### T3 — 凭据走 EnvironmentFile ✅

- [x] `/etc/alysia-runner.env`（`600 root:root`）：`DEEPSEEK_API_KEY` / `ALYSIA_WEBUI_TOKEN` / `ALYSIA_BASE_URL`
- [x] systemd 以 **root 读环境文件 → 再降权**（runner 用户 `test -r` **拒绝**）
- [x] ⚠️ 有意保留的取舍：进程里当然有 token（否则回传不了）——
      「只许调 ingest / project-result 的受限令牌」列为后续

### T4 — systemd 常驻 ✅

- [x] `/etc/systemd/system/alysia-task-runner.service`：`User=alysia-runner`、`Restart=always`、
      日志 `append:/srv/alysia-runner/logs/runner.log`
- [x] `enable --now` → `active`、`NRestarts=0`、进程身份实测为 `alysia-runner`
- [x] 服务端 `projects.alysia-blog.workspace` 切到 `/srv/alysia-runner/blog`
      （备份 config + YAML 校验 + 核对 10-16 的 `max_tokens` 未被回退）

### T5 — 端到端（**不手工跑 runner**）✅

- [x] 建任务 → 服务 17 秒内自动认领 → 10 秒执行 → `needs_review`，`result.final=HARDEN-OK`
- [x] 工作区 `/srv/alysia-runner/blog`（空、未改动）；旧 `/root/alysia-blog` 原样保留
- [x] 委托会话 3 条事件**全部**标记、摘要 0（降权没有破坏记忆隔离）
- [x] 顺带验证：容器重启期间 runner 收到 `HTTP 500` → **不退出、按间隔重试**（符合设计）

## 未做（另立 change）

- [ ] `add-approval-gate`：answerer 插件 + `/api/approvals` + QQ 提问 + 超时拒绝 + `needs_approval` 状态
- [ ] 出站网络白名单（博客构建要拉 npm/字体，先放行但留审计）
- [ ] 受限令牌（不让委托运行体持有全权 token）

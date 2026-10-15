# Tasks: migrate-server-to-new-host

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 本 change 是 **MODIFY + DOC**：动的是运维脚本与文档，**不碰 core / server 代码**。

## 实现任务

- [x] `sync-from-server.sh`：`SERVER` 改为 `"${ALYSIA_SERVER:-root@<SERVER_IP>}"`（目标机可配置）
- [x] `sync-from-server.sh`：凭据分支条件化 —— 远程 `id -u` 为 0 时 `SUDO_PREFIX=""`（免凭据），
      否则走原优先级链（env `SUDO_PASS` > `$HOME/.alysia-deploy-credentials` > 报错退出）
- [x] `sync-from-server.sh`：所有 `sudo -S` 调用点改用 `${SUDO_PREFIX}`
      —— **实测 5 处**（docker cp ×2 / docker exec ×2 / **chown ×1**），逐处核对，
      禁止漏改导致 root 场景仍要求密码。★ 修订：立项时记的"6 处"是估数，实测为 5 处；
      且其中一处是 `sudo -S chown` 而非 docker，故前缀名取 `SUDO_PREFIX` 而非 `DOCKER_PREFIX`
- [x] `docs/Docker-Deployment.md`（gitignored）：前置条件改为「密钥已装，`ssh root@<SERVER_IP>` 免密」
- [x] `docs/Docker-Deployment.md`：架构图与「凭据管理」段更新 —— 新机 root 免密，
      `SUDO_PASS` 机制保留为**非 root 服务器**的回落路径
- [x] `docs/Docker-Deployment.md`：Step 4 / 一键部署 / 日常运维 / 回滚 去掉 `echo '<SUDO_PASSWORD>' | sudo -S`
- [x] `docs/Docker-Deployment.md`：补新机差异 —— 阿里云北京 ECS、`PasswordAuthentication no`（只能密钥）、
      **6186 需安全组放行**（默认未放行，控制台从公网打不开）、镜像源需 `releasever=8` 钉死
- [x] `.gitignore`：忽略 `.tools/`（运维工具落点；本条**已在迁移过程中落地**）

## 验证任务

- [x] **root 分支**：新机上不设 `SUDO_PASS`、无凭据文件 → `sync-from-server.sh` 完整跑通
      （实测输出 `✓ 远程为 root（uid 0）→ 免凭据直连`，导出 → scp → 校验 → 替换全绿）
- [x] **非 root 分支不回退**：`ALYSIA_SERVER` 指向非 root 用户且不给凭据 →
      打印指引 + `exit 1`（实测 `EXIT_CODE=1`，且打印了探测到的 `uid=1002` 与新增的"方式三"提示）
- [x] 导出库 `PRAGMA integrity_check` = ok，关键表计数与线上一致（events 1807 / life_events 615 / facts 84）
- [x] 本地旧库产生 `alysia.db.bak-<时间戳>`（回滚锚点）后才被替换
      —— 实测 `alysia.db.bak-20261015-213807`；另在 `.tools/backup/` 做了**额外**全量备份（69MB）
- [x] 全仓 grep 旧机地址与真实主机标识：**跟踪文件零命中**（`git grep` 验过；
      `openspec/` 内一律 `<SERVER_IP>` 占位符）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
      §「★ 8-28 运维工具：服务器数据同步」（追加 † 段，L1011-1046）
- [x] 更新 `openspec/specs/index.md`：`memory-system` 行「最后变更」追加本 change
- [x] 归档到 `openspec/archive/2026-10-15-migrate-server-to-new-host/`

## 未提交说明

本 change 的三个改动文件（`.gitignore` / `openspec/specs/index.md` /
`openspec/specs/memory-system/spec.md`）**未执行 git commit**：

- 工作区另有 **19 个与本 change 无关的 `packages/console` 未提交改动**，
  以及若干未跟踪的新目录（`add-theme-system` / `improve-sticker-system` / `console/app/settings` 等）
- 在此状态下提交会把这些无关改动一并卷入——**提交时机与范围由用户决定**
- 两个目标文件（`sync-from-server.sh` / `docs/Docker-Deployment.md`）本就是 gitignored，
  改动只落在本机，天然不进仓库

## 备注：本 change 明确不做

- **不动 core / server 代码** —— 迁移已完成，无需为迁移改应用代码
- **不改 `docs/DEPLOYMENT.md`（对外指南）** —— 它通篇是 `<your-server>` 占位符，
  面向 GitHub 使用者，与具体主机无关
- **不清理旧机** —— 按迁移计划保留 3~7 天作回滚锚点（旧机磁盘 81%，
  回收时 `docker system prune` 可释放约 14G，属后续独立动作）
- **不删 `$HOME/.alysia-deploy-credentials`** —— 旧机在回滚窗口内仍需 sudo 密码；
  旧机废弃后再删（单独动作，不夹带）
- **不做 LanceDB 瘦身** —— 线上 `vectors` 表 2602 行却占 576M / 14260 文件
  （1024 维算下来本应约 10.6M），是历史版本与碎片堆积；迁移纪律要求**保真**，
  瘦身（`compact_files` + `cleanup_old_versions`）另开 change
- **不禁用阿里云 AccessKey** —— 那是用户的账号操作（RAM 控制台），
  本 change 只记录「迁移后应禁用」的提示

# Tasks: prune-old-rollback-images

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] 新增 `scripts/lib/rollback-retention.mjs`：`parseImageList` / `planRollbackPrune` /
      `buildPruneScript` / `resolveKeep` + 正则白名单 `ROLLBACK_TAG_RE`
- [x] `scripts/deploy.mjs`：Step 1b 只读盘点（`--dry-run` 打印将保留/将删）
- [x] `scripts/deploy.mjs`：Step 6 部署成功后回收旧回滚点（保留 N，默认 3）
- [x] `--keep-rollbacks=N` / `ALYSIA_ROLLBACK_KEEP` 解析（非法值退回 3，负数不钳到 0）
- [x] 清理后验收输出：`latest=present` / `health=` / `disk=`；`latest` 缺失 ⇒ 非 0 退出
- [x] 失败/自动回滚分支不清理（在 Step 5 内 `exit`，控制流保证）
- [x] 单测 `packages/server/tests/deploy-rollback-retention.test.ts`（19 条，全绿）

## 验证任务（真机）

- [x] 单测：19/19 通过（Node 24，`packages/server`）
- [x] 真机 e2e：生产打假标签 `rollback-19700101-e2e` → 跑同一套流程 →
      只删假标签、真实回滚点与 `latest` 原样、`health=200`
- [x] 生产健康复查：`docker ps` = `Up (healthy)`、`/api/health` = `{"status":"ok"}`

## 环境清理（一次性，非代码；2026-10-25 用户确认后执行）

- [x] **生产**：删 27 个过期回滚标签 + `docker image prune -f`（悬空 9 个，2.203GB）
      ⇒ Images 37/8.736GB → 4/1.115GB；`/` 23G → 15G（62% → 41%）
- [x] **本机**：`docker builder prune -af`（21.24GB → 0）+ 删 `halohub/halo:2.20`（×2 标签，675MB）
      与 `hello-world` ⇒ Images 1.597GB → 921.7MB；保留 `server-alysia:latest`、`node:22-alpine`
- [ ] **本机仓库杂物（待用户拍板，未做）**：`packages/server/alysia-image.tar`(125.6MB)、
      `packages/core/alysia-deploy.tar.gz`(123.1MB)、`.tools/staging/*.tar.gz`(2×124.8MB) ——
      均未被 git 跟踪，是部署中间产物；`node_modules` 下的同尺寸副本经 pnpm 硬链接，删除收益不确定

## Apply 任务（实现完成后）

- [x] 新建 `openspec/specs/deploy-pipeline/spec.md`（全新 slug，见 change 的 spec.md）
- [x] 更新 `openspec/specs/index.md`（新增一行 + Backlog 无需变更）
- [x] 更新 `docs/Docker-Deployment.md`（回滚节的保留策略 + 日常运维的磁盘/镜像检查）
- [x] 更新 `CLAUDE.md` 部署小节（④ 回滚点自动清理）
- [x] 运行残留校验 `E:\nodejs24\node.exe scripts/check-spec-diff-residue.cjs`（exit 0：0 行残留）
- [x] 归档到 `openspec/archive/2026-10-25-prune-old-rollback-images/`
- [x] `--dry-run` 真机验证（`exit 0`）：Step 1b 打印「回滚点 3 个 ⇒ 保留 3 / 将删 0」，未改动服务器

## 部署说明（本次无需再发版）

改动全在**本地运维脚本**（`scripts/`），服务器侧字节零变化 ⇒ 不需要重新构建/推送镜像。
新逻辑在下一次正常部署时首次生效；因为幂等（只删超出 N 的 `rollback-*`），
那次部署会顺带把多余回滚点收掉。

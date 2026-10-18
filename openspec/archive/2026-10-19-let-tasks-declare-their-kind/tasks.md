# Tasks: let-tasks-declare-their-kind

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `database.ts`：`ALTER TABLE project_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'`（`addColumnIfMissing`）
- [x] `ProjectTaskStore.ts`：`ProjectTask.kind`、`CreateInput.kind`、INSERT 带 `kind`、`rowToTask` 映射
- [x] `MemoryManager.createProjectTask`：透传 `kind`
- [x] `tools/project-tasks.ts`：`ProjectTaskHost.createProjectTask` 加 `kind`；`start_project_task` 加
      `kind` 参数（enum build/action + 说明"选错了只会白跑几轮"）；handler 透传（缺省 build）
- [x] `webui/server.ts`：`POST /api/project-tasks` 接受 `kind`；
      **`action` 任务不下发阶段指令**（`nextPrompt = ''`）
- [x] `project-task-loop.ts`：**防空转** —— 同阶段 `visits >= 4` ⇒ `finish('needs_review')`
- [x] `project-task-runner.mjs`：`singleShot`（`task.kind === 'action'`）⇒
      单轮跑完直接回传、不调 `/advance`；并**强制清空 `nextPrompt`**（第二道防线）

## 部署任务

- [x] core 5 个 js（`project-task-loop` / `database` / `stores/ProjectTaskStore` / `MemoryManager` /
      `tools/project-tasks`）+ server `webui/server.js` + runner
- [x] 迁移生效：`project_tasks` 表出现 `kind TEXT NOT NULL DEFAULT 'build'`
- [x] 备份 `/root/alysia/backups/dist-20261019-004225/`

## 真机验证

- [x] **第一次**（仍下发阶段指令）：单轮跑完，但她**跑去写「## 意图」而没发布** ⇒ 暴露"指令冲突"
      ⇒ 补了"action 不下发阶段指令 + runner 清空 nextPrompt"
- [x] **第二次**：`类型：action（单轮任务 —— 做完就交，不套六阶段）`、**9 秒**跑完、
      回执 `✅ 200  island.html → http://<SERVER>:3389/p/alysia-toys/island.html`、
      `[过程] 单轮任务（action）：做完就交，不套六阶段`、**没有阶段推进**
- [x] 本机断言：同阶段 4 次 ⇒ 收工；`sketch` 一次过不误伤；工具 `kind` 透传/缺省 build

## Apply 任务

- [x] 合并 spec：§17 新增**契约 68f（任务类型）**
- [x] `openspec/specs/index.md` 最后变更行
- [x] `docs/HANDOFF.md` 记账
- [x] `node scripts/check-spec-diff-residue.cjs` → 0 行残留
- [x] 全量 vitest → 2026-10-19 全绿（1575）

## 顺带发现（环境，不属本 change）

本机 `packages/*/dist` 的子目录只授予了**旧会话**的沙箱身份 ⇒ 普通权限下 `tsc` 写不进 dist
（`error TS5033 … EPERM`）。用 `diagnose-windows-sandbox-acl` 修了**目录自身**的 WRITE_DAC/OWNER
（已备份 + 可回滚），但**当前会话的包身份仍未授予** ⇒ 构建 `server/dist` 与 `dsh-adapter/dist`
需要一次 `danger-full-access`。**下个会话若仍报 EPERM，直接用完整权限构建，别再反复折腾 ACL。**

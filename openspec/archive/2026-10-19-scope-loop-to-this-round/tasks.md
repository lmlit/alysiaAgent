# Tasks: scope-loop-to-this-round

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `scripts/project-task-runner.mjs`
  - `phaseAllowlist` 收口到 `public/**`（后续被 `give-her-a-publish-tool` 整体废掉，见该 change）
  - `SKIP_DIRS` += `.tmp`（工具缓存不进快照）
  - `collectFacts(workspace, sinceMs)`：drafts/shots/builtPages 按 `mtime ≥ sinceMs` 过滤，并回 `notesMtime`/`sinceMs`
  - `PHASE_TIMEOUT_SEC` + `timeoutForPhase(phase, forced)`；`--timeout` 改成"显式统一覆盖"（默认 null）
  - 超时杀**进程组**（`detached: true` + `process.kill(-pid)`）
- [x] `packages/core/src/memory/project-task-loop.ts`
  - `LoopFacts` 加可选 `notesMtime` / `sinceMs`
  - `intent` / `review` / `statement` 三处闸门加 `notesTouchedThisRound()`；两个字段都缺时按老行为
- [x] `packages/server/src/webui/server.ts`：`/advance` 透传 `notesMtime` / `sinceMs`（`asNum`，缺省不下发）
- [x] 测试：`project-task-runner.test.ts`（`.tmp` 不进快照 / `collectFacts` 只算本轮 / `timeoutForPhase`）
      + `project-task-loop.test.ts`（旧笔记 → stay，新笔记 → 前进，缺字段 → 老行为）
- [x] 她的文档：`AGENTS.md`（toys + blog）加「两个边界，别混」

## 部署任务

- [x] runner → `/srv/alysia-runner/`（`node --check` 通过，systemd 重启）
- [x] 容器 dist 热替换：`core/dist/memory/project-task-loop.js` + `server/dist/webui/server.js`
      备份 `/root/alysia/backups/dist-20261018-234808/`
- [x] runner 启动行确认：`timeout=按阶段（… build 5400s）`

## 真机验证

- [x] 本机纯函数验收（27 条断言全过）：`.tmp` 跳过、`collectFacts` 只算本轮、按阶段超时、
      `advanceLoop` 旧笔记 → 原地重试
- [x] 线上集成探针（`pt-d5127b0f…`，测试会话 ⇒ 不推 QQ）：
      `notesMtime < sinceMs` → `next=intent`「「## 意图」是上一轮留下的」；
      `notesMtime ≥ sinceMs` → `next=sketch`；两个字段都不带 → 老行为（`next=sketch`，被草图数挡住）
- [x] **真实任务跑过**（2026-10-19，`give-her-a-publish-tool` 那几轮）：sketch/单轮里写整页
      **没有**再出现 `.phases/violations/` 新增（没收机制已整体删除）

## Apply 任务

- [x] 合并 spec：§17 新增契约 68b / 68c / 68d
- [x] `openspec/specs/index.md` 最后变更行
- [x] `docs/TODO.md` B 节两行销账；`docs/SESSION-2026-10-18-DELEGATED-RUNTIME.md` 四补标"已修"
- [x] `docs/HANDOFF.md` 记账
- [x] `node scripts/check-spec-diff-residue.cjs` → 0 行残留
- [x] 全量测试：2026-10-19 用 Node 24 全绿（core 958 / server 371）

## 说明

本 change 里的"写权限分层"后来被 `give-her-a-publish-tool` 进一步推翻（**没收机制整个删掉**），
所以契约 68c 现在是"不搬文件、只记账"。**两个 change 顺序归档即可，不必回填。**

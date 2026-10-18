# Tasks: unify-her-voice-across-engineering

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `render-dialogue.ts`：`ENGINE_SPEAKER` → `我（工程环境）`；注释讲清"是她，但不是她的聊天发言"
- [x] `project-task-result.ts`：回执首行 `【我这次的执行记录】`；通知 system 改第一人称 + 两条禁令；facts 改第二人称
- [x] `tools/project-tasks.ts`：三处工具描述 + 状态文案 + `renderTask`（含 `页面地址` 输出）
- [x] `webui/server.ts`：机械回落模板 `我这一轮跑完了：…`；两处注释对齐
- [x] 测试更新：`render-dialogue.test.ts`（标签语义）/ `project-task-result.test.ts`（首行 + 两条禁令 + facts 人称）/
      `project-tasks-tool.test.ts`（`页面地址` 原样给出 + 不含"执行端"）
- [x] 全仓扫 `工程那边|执行端`：源码里只剩**注释**与**禁令原文**（`project-task-result.ts:104-105`）

## 部署任务

- [x] 重建 dist（`--outDir .probe/core-dist` / `.probe/server-dist`，绕过本机 `dist|tsbuildinfo` 写权限）
- [x] `docker cp` **core 3 个 js**（`memory/render-dialogue.js`、`memory/project-task-result.js`、`tools/project-tasks.js`）
      + **server 1 个 js**（`webui/server.js`）→ `docker restart alysia-server`
      备份：`/root/alysia/backups/dist-20261018-233818/`
- [x] 真机探针（`pt-f4092b16…`，测试会话 ⇒ 不推 QQ）：通知草稿 =
      「**我把 island.html 做出来了**……地址是 `…/w/alysia-toys/island.html`」；禁用词命中 **0**；
      回执事件正文首行 = `【我这次的执行记录】`

## Apply 任务

- [x] 合并 spec：`project-tasks` §15 新增**契约 63b**、契约 54/56/57 更正、§10 契约 29/30 口径对齐
- [x] `openspec/specs/index.md` 最后变更行
- [x] `docs/HANDOFF.md` 记账（含热替换部署形态）
- [x] `node scripts/check-spec-diff-residue.cjs` → 0 行残留
- [x] 全量测试：2026-10-19 用 Node 24 全绿（core 958 / server 371 / adapter 138 / dsh-console 8 / console 100 = 1575）

## 数据补救（用户批准：「继续，改历史记录吧」）

那条 `unknown` 的旧任务（`pt-80bc564b…`）在改动前就回传了，`artifacts` 是空 ⇒
用户问"上次那个海岛"，她手上还是没有地址。已补写（**只补事实，不改她的话**）：

| 表 | 对象 | 改动 |
|---|---|---|
| `project_tasks` | `pt-80bc564b…` | `artifacts`：`[]` → `[{"path":"island.html","published":false,"url":"http://<SERVER>:3389/w/alysia-toys/island.html"}]` |
| `project_tasks` | 同上 + `pt-eb3a09f3…` | `result.final` 里 runner 追加的**越界文件清单**（53 / 988 条 `.tmp` 路径，把 1200 字预算吃光）→ 一句摘要（处数取自 `runner.log` 的权威数字，**不是**从截断正文反推） |
| `events` | `project-task:pt-80bc564b…:r0` | 正文**末尾追加**一行 `[更正 …]`：上面那个是项目门牌（旧页），这一轮页面是 island.html + `/w/` 地址 |
| `events` | `project-task:pt-eb3a09f3…:r0` | 同上：这一轮只出草稿，页面在下一轮做成 |

证据：`island.html` 由 `pt-80bc564b` 那一轮产出（`.phases/violations/r2` 里原样存在，已还原）；
更早的 `pt-eb3a09f3` 隔离区（`r4`）里**没有** `island.html` ⇒ 只出草稿，符合它的结局。

**真机验证（容器内、用已部署的 dist + 生产库跑 `renderTask`）**：
两条任务现在都**不含** `/p/` 门牌；`pt-80bc564b` 输出
`你这一轮做出来的文件：island.html` + `页面地址（原样转给用户，不要改写）：…/w/alysia-toys/island.html`；
`pt-eb3a09f3` 如实没有页面（它只有草稿）。

⚠️ **回滚方式**（本 change 无改动前的库快照）：把 `artifacts` 置回 `[]`，删掉两条事件正文里的
`[更正 …]` 段与 `corrected_at` 字段即可（原值在本文档里）。事后备份：
`/root/alysia/backups/alysia.db.bak-artifacts-20261018-234119`
（`VACUUM INTO` 在宿主 sqlite **3.26** 不支持，第一次没做成，改用 `.backup`；所以那份是**改后**快照）。

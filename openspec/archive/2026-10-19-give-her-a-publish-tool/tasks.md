# Tasks: give-her-a-publish-tool

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `packages/dsh-adapter/src/publish-page.ts`：`planPublish()`（纯函数）+ `createPublishPageTool()`
      - 路径校验（工作区内/非隐藏/扩展名白名单/不许从 `public/` 取源）
      - **自动带上页面引用的相对资源**（`src=` / `href=`，外链/绝对/data 跳过）
      - 复制进 `public/`；`home` 同时写 `public/index.html`
      - **HTTP 自证**（本机预览服务）：200 / 非 200 / 验不了（如实标"未验"）
      - `ALYSIA_ALLOW_PUBLISH=0` ⇒ 拒绝
- [x] `packages/dsh-adapter/src/index.ts`：注册工具（`ctx.tools.register`）
- [x] `packages/dsh-adapter/src/node-env.d.ts`：**刻意授予** `fs`/`path`/`fetch`/`process.cwd` 的最小类型
      （并在注释里写清"这是 capability，不是顺手开门"）
- [x] `packages/core/src/memory/project-task-loop.ts`：`PHASE_PROMPTS.publish` → 调 `publish_page`
- [x] `scripts/project-task-runner.mjs`
      - `rollbackOutOfPhase` → `inspectPhaseWrites`：**只记账、不搬文件**（`moved` 恒空）
      - 回执措辞：「[绕过 publish_page 直接动了 public/] …（文件没动，已保留）」
      - 认领响应里的 `allowPublish` ⇒ `ALYSIA_ALLOW_PUBLISH=1|0` 透传给 dsh
      - 删掉已无用的 `phaseAllowlist` 与 `mkdirSync/renameSync/path` 依赖
- [x] `packages/server/src/webui/server.ts`：`allowPublishForTask()`（`self` ⇒ 配置；其余 ⇒ 允许），
      认领响应带 `allowPublish`，`/advance` 用同一判据
- [x] 测试：
      - `packages/dsh-adapter/tests/publish-page.test.ts`（13 例）
      - `packages/server/tests/project-task-runner.test.ts`：改为 `inspectPhaseWrites`（只记账）

## 部署任务

- [x] adapter：`tsc --outDir .probe/adapter-dist` → 覆盖 profile 里
      `.dsh/profiles/alysia/node_modules/@alysia/dsh-adapter/dist/{index.js,publish-page.js,publish-page.d.ts}`
      ⚠️ **没重新打包 tgz**：`pnpm install` 会把它还原成旧版（记在这里）
- [x] runner → `/srv/alysia-runner/project-task-runner.mjs`
- [x] 容器 dist：`core/dist/memory/project-task-loop.js` + `server/dist/webui/server.js`，restart
- [x] 备份：`/root/alysia/backups/dist-20261019-001613/`

## 真机验证

- [x] adapter 冒烟（假 ctx、不跑模型）：`tools = recall_memory, publish_page` ✅
- [x] 认领探针（`pt-7e087db0…`，测试会话）：`allowPublish = True`（origin=delegated）✅
- [x] 本机 18 条断言全过（路径/资源/拒绝/`ALLOW_PUBLISH=0`/真复制/未验不谎报）
- [x] **她在真 dsh 里调成功**（systemd-run 带 runner 环境，`turn_end.reason=completed`）：
      `✅ island.html → http://<SERVER>:3389/p/alysia-toys/island.html`
      她还自己 curl 复核了一遍两个 200，并把地址直接给出来 ✅

### 真机跑出来的三个 bug（都已修，且都值得记）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 整个 dsh **fatal uncaught exception**，退出码 1、没有 `turn_end` ⇒ runner 判 `unknown`，她在对话里只说了半句 | `fetch` 只取 `res.status`、**没读 body** ⇒ undici `assert(!this.paused)` 在 socket 结束时炸（`Parser.finish`） | `probe()` 里 `await res.arrayBuffer()` 读掉 body |
| 2 | 她贴出的地址是 `http://127.0.0.1:3389/…`（**用户点开必然打不开**） | 第一版 `publicBase()` 把自证用的回环地址当成了对外地址 | 拆成两个：`publicBase()` 取 `.alysia-project.json` 的 `publicUrl`（对外）/ `verifyBase()` 回环（只用于自证） |
| 3 | 工具输出只有 `✅` 没有状态码，她还得自己去 curl 复核 | render 没打状态码 | `✅ 200  file → url` |

### 另一件（流程问题，未修，已登记）

探针任务 `pt-b384e591…` 在 `intent` 阶段**空转 7 轮**：目标写的是"只发布、别改文件"，
而阶段闸门要求先写「## 意图」⇒ 两者打架。它连着调了 5 次 `publish_page`（每次都成功），
却因为闸门不过而反复重跑，最后由操作员收尾。
⇒ **"不是做新东西"的任务不该被套上六阶段循环**。这是下一个 change 的事（记在 `docs/TODO.md`）。

- [x] 发布留痕：`.alysia-publish-log.jsonl`（让 runner 分得清"走正路"与"手工 cp"，不冤枉她）

## 待办（本 change 不做）

- [x] 她的 `AGENTS.md`「发布契约」已改成 `publish_page`（2026-10-19，两个项目同步；改前备份）
- 遗留（不阻塞归档）：`publish.sh` 已不是正路，文件本身留着不删（她跑它也不会被没收，只是不算发布）—— 是否删由用户定
- [x] 任务目标与阶段闸门的冲突（见上「空转 7 轮」）→ **已由 `let-tasks-declare-their-kind` 修掉**

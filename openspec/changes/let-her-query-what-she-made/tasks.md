# Tasks: let-her-query-what-she-made

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `scripts/preview-hub.py`：除 `pages.html` 外再写**机器可读**的 `/srv/alysia-preview/pages.json`
      （`{generatedAt, pages:[{projectId,file,title,url,published,updatedAt}]}`，原子写）
- [x] `scripts/project-task-runner.mjs`：`pushPagesIndex()` —— 每轮轮询先把清单
      `POST /api/host/pages`（best-effort：失败只 warn，不影响认领/执行）
- [x] `packages/server/src/host-pages.ts`：进程内缓存 + `parseHostPagesInput()`（形状不对返回 null，不存半份坏数据）
- [x] `packages/server/src/webui/server.ts`：`POST /api/host/pages`（400 on bad shape）+ `GET /api/host/pages`（自查）
- [x] `packages/server/src/modules/core.ts`：`hostPages: () => hostPagesCache.get()` 注入 core
- [x] `packages/core/src/tools/project-tasks.ts`：`PagesProvider` + `list_my_pages` / `find_page`（只读）
- [x] `packages/core/src/{options,index}.ts` + `modules/capabilities.ts`：把 `hostPages` 透传到工具，
      并在注册时打一行日志（"挂没挂上"必须能观测）
- [x] 测试：`packages/core/tests/project-task-pages-tool.test.ts`（12 例，含"只读"反向守卫）

## 部署任务

- [x] hub → `/opt/alysia-preview/preview-hub.py`，手跑一次：`13 个 · json 已写`
- [x] runner → `/srv/alysia-runner/`（第一次踩了重复声明 `PAGES_INDEX_PATH` 导致 crash-loop，已修）
- [x] 容器 dist：core 4 个 js + server 3 个 js（`host-pages.js` / `modules/core.js` / `webui/server.js`）
- [x] 备份 `/root/alysia/backups/dist-<ts>/`

## 真机验证

- [x] `/srv/alysia-preview/pages.json` 生成（13 页）
- [x] `GET /api/host/pages` → `count = 13`，`generatedAt 2026-10-19T01:45:20`，runner 重启后
      20s 内被重新推回（`receivedAt` 更新）
- [x] 容器启动日志：`[tools] 已注册页面查询工具：list_my_pages / find_page`
- [ ] **由用户在 QQ 里问一次「你都做过哪些页面」** —— 这是唯一能验证"LLM 会不会用新工具"的方式，
      本 change 自证不了

## 遗留（不阻塞归档）

- `docs/Web-API-Design.md` 要补 `POST/GET /api/host/pages` 两条（下一轮文档改动一起做）
- 用户提的第二件事——「dsh 插件还可以帮她**操作我们的服务器**」—— 是**能力面扩张**，
  需要先定清单（只读的服务状态/日志？还是要能做动作？），另开 change

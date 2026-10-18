# Tasks: fix-receipt-link-to-produced-page

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。
> 实现走执行工具，本文件只记账。

## 实现任务

- [x] `scripts/preview-hub.py`：新增 `w/<id>` 只读通道（符号链接 → 工作区根），清理逻辑同时覆盖 `p/` 与 `w/`
- [x] `scripts/preview-serve.py`：`/w/` 下扩展名白名单 + 隐藏/敏感路径 404（`.md`/`.json`/`.sh`/`.tmp`/`.phases`）
- [x] `scripts/project-task-runner.mjs`：`artifactPages()` / `previewBase()` / `pageUrl()`；`submit()` 回传 `artifacts: [{path, published, url}]`
- [x] `packages/server/src/webui/receipt-url.ts`：`pickPageUrl()`（合法前缀校验）+ server.ts 三处地址改用 `receiptUrl`
- [x] 单测：`packages/server/tests/project-task-receipt-url.test.ts`（14 例；**本机沙箱跑不了 vitest**，见下）
- [x] 她的文档：`AGENTS.md` 增「预览地址 `/w/`」一节（toys + blog 两份）；`.alysia-project.json` 加 `previewUrl`

## 部署任务（2026-10-18 23:2x 已完成）

- [x] `/opt/alysia-preview/`：`preview-hub.py` + `serve.py`（改名前备份 `.bak-<时间戳>`），`systemctl restart alysia-preview`
- [x] 手动跑一次生成器：`p/` 与 `w/` 都在，基站仍 11 卡
- [x] `/srv/alysia-runner/project-task-runner.mjs` + `systemctl restart alysia-task-runner`
- [x] 容器 dist **热替换**：`docker cp` `webui/receipt-url.js` + `webui/server.js` → `docker restart alysia-server`
      （旧 `server.js` 备份在 `/root/alysia/backups/dist-<ts>/`；**下次正式发版会整体重建镜像，届时以镜像为准**）

## 真机验收（已完成）

- [x] `/w/alysia-toys/island.html` → 200（86 KB）；`/w/alysia-toys/vendor/three.min.js` → 200（669 KB）
- [x] `/w/…/NOTES.md` `/w/…/AGENTS.md` `/w/…/.alysia-project.json` `/w/…/.tmp/probe.html` `/w/…/publish.sh` → **全 404**
- [x] 编码绕过 `/w/…/%2Etmp/probe.html` → 404
- [x] `/`（基站）与 `/p/alysia-toys/` `/p/alysia-toys/waiting.html` → 200（未回归）
- [x] 集成探针（`pt-6708b624…`，测试会话 ⇒ 不推 QQ）：日志「通知草稿」末尾地址 =
      `http://<SERVER>:3389/w/alysia-toys/island.html` —— **契约 38 落地**
- [x] 无产物页时回落门牌：同批日志里旧任务（改前代码）仍是 `…/p/alysia-toys/`，符合"如实回落"

## Apply 任务（实现完成后）

- [x] 合并进 `openspec/specs/project-tasks/spec.md`：§11 新增 **契约 38c**；§10 契约 26 口径对齐
- [x] `openspec/specs/index.md`（project-tasks 行"最后变更"）
- [x] `docs/TODO.md` / `docs/KNOWN-ISSUES.md` 记账（含本次发现的三个结构性问题）
- [ ] ⚠️ 本 change 的 `spec.md`（"变更后的完整 spec"）**未单独落盘**：spec 已直接合并进活 spec；
      归档时以 `openspec/specs/project-tasks/spec.md` 为准（沙箱拒写该路径，见下）
- [x] 跑 `node scripts/check-spec-diff-residue.cjs` → 0 行残留
- [x] 跑 core / server 全量测试 → 2026-10-19 全绿（core 958 / server 371）

## ⚠️ 本机环境限制（留给下一个会话）

- `npx vitest run` 在本机会挂在 `spawn EPERM`（沙箱不允许子进程管道）⇒ **测试必须在服务器或用户自己的终端跑**
- `packages/server/dist/` 与 `openspec/changes/<name>/` 对 PowerShell 写入被拒 ⇒
  用 `npx tsc --outDir .probe/server-dist` 出产物，再用文件工具写文档

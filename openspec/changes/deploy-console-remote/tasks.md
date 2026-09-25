# Tasks: deploy-console-remote

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `packages/server/Dockerfile` runtime 阶段加 `COPY packages/console/out ./packages/console/out`
      （含注释说明为什么不在 Docker 里构建）
- [x] `docs/Docker-Deployment.md` Step 2 加 `pnpm build:console` 步骤 +
      "`out/` 存在但是旧的会静默打包旧前端"告警
- [x] `docs/Docker-Deployment.md` Step 3 打包前加 `host` 自查
      （`grep -n "^ *host:" config.yml` 有输出则中止 —— 防 `server-bind-host` 的回环配置流入部署包）

## 待用户执行（需要服务器凭据，本机无法代劳）

- [ ] `pnpm build:console` 产出 `out/`
- [ ] 开启 Docker Desktop → `cd packages/server && docker compose build`
- [ ] 确认镜像里确实有前端：`docker run --rm --entrypoint ls server-alysia:latest /app/packages/console/out`
- [ ] 按 SOP 走部署（save → scp → load → up -d --force-recreate）
- [ ] 验收：`http://<SERVER_IP>:6186/` 打开是新前端；`/life` 命中 life 页；
      无 token 打 `/api/life` → 401（服务端仍强制鉴权）

## 未验证（诚实记录）

- ⚠️ **镜像构建未实测** —— 2026-09-25 本机 Docker Desktop 未运行。
  改动只有一行 `COPY` + 文档，但**必须实跑一次 `docker compose build` 才算数**
- ⚠️ 服务器 SSH 凭据在 `docs/Docker-Deployment.md` 里是占位符（`<SERVER_IP>` / `<USER>` / `<SUDO_PASSWORD>`），
  远端步骤由用户执行

## Apply 任务（实现完成后）

- [ ] `openspec/specs/alysia-console/spec.md` §1：补远端部署的产物路径与镜像要求
- [ ] 更新 `docs/HANDOFF.md`
- [ ] 回归测试

## 备注：另一条路（不部署也能看服务器数据）

本地 dev 直连远端 API，无需部署：

```bash
ALYSIA_API=http://<SERVER_IP>:6186 pnpm dev:console
```

浏览器里粘**服务器**的 `ALYSIA_WEBUI_TOKEN`（在服务器 `~/alysia/.env`，与本地那个不同）。
适合临时查看，不适合日常使用（要一直开着 dev server）。

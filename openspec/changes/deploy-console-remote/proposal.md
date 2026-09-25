# Change Proposal: deploy-console-remote

## 元信息

- **日期**: 2026-09-25
- **类型**: MODIFY（部署产物）
- **状态**: in_progress
- **影响 spec**: `alysia-console`（§1 生产形态补远端部署）

## 动机（为什么做）

用户问：「能否接入服务端的数据」——服务器上那个跑了 24 小时的实例才是**真正的她**
（真实 QQ bot、数周的生活积累），本地这份是开发副本。

现状：`packages/server/Dockerfile` **只 COPY core 和 server**，镜像里没有前端产物，
所以 `http://<SERVER_IP>:6186` 只有 `/api/*`、没有界面 —— 新前端压根没上过服务器。

## 需求（做什么）

- [ ] Dockerfile runtime 阶段加 `COPY packages/console/out ./packages/console/out`
- [ ] 部署 SOP（`docs/Docker-Deployment.md`）加"先 `pnpm build:console`"步骤 + 忘记构建的告警
- [ ] 部署 SOP 加打包前 `host` 自查（防 `server-bind-host` 的回环配置流入部署包）
- [ ] 实测镜像构建 + 容器内前端可访问

## 设计决策（怎么做，含备选与取舍）

**决策 1：本地构建 `out/` 后 COPY 进镜像，不在 Docker 里构建前端**

`next build` 要联网下 Google Fonts（`next/font` 自托管 woff2，实测 11 个文件）。
在 alpine 构建阶段跑 next 既慢又脆，还要把 next/react 一整套依赖装进 builder。
备选是加构建阶段 + npmmirror 处理字体（Dockerfile 里对 npm 已有先例），
但收益只是"少一步本地命令"，代价是显著拉长构建时间与失败面。否决。

代价：忘记 `pnpm build:console` 时 `COPY` 会直接**报错**（响亮失败，好过静默出无前端镜像）；
但 `out/` 存在却是**旧的**会静默打包旧前端——靠 SOP 告警覆盖。

**决策 2：镜像里前端路径 = `packages/console/out`**

与 `bootstrap.ts` 的 `resolve(serverDir, '../../console/out')` 对齐
（`serverDir` = 容器内 `/app/packages/server/dist` → `/app/packages/console/out`）。

**决策 3：服务端保持 `0.0.0.0` + 强制鉴权**

服务器对外，**不套用本机的回环配置**。容器里没有 `ALYSIA_HOST` → 回落 `0.0.0.0`，
鉴权自动开启。`server-bind-host` 的运行时兜底会在容器误绑回环时 `logger.error`。

## 对账方向确认

- [x] 是否与现有 spec 冲突？无——`alysia-console` §1 只写了生产形态是"Fastify 同源托管"，
      未区分本地/远端。本 change 补远端部署的产物路径
- [x] 涉及 Web API？**不涉及**

## 风险

1. **Docker Desktop 未运行 → 镜像构建未实测**（2026-09-25）。改动仅一行 COPY +
   文档，风险低，但**必须实跑一次 `docker compose build` 确认**。
2. 远端部署需要服务器 SSH 凭据（`docs/Docker-Deployment.md` 里是占位符），
   由用户执行；本 change 只准备产物与文档。

## 测试计划

- `docker compose build` 成功，镜像内含 `/app/packages/console/out/index.html`
- 容器起来后 `curl http://localhost:6186/` 返回新前端 HTML（标题「昔涟 · 一个有生活的 AI 伙伴」）
- `curl http://localhost:6186/life` 命中 life 页（不是首页）
- 无 token 打 `/api/life` → 401（服务端仍强制鉴权）

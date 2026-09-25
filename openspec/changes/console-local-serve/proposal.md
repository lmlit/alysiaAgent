# Change Proposal: console-local-serve

## 元信息

- **日期**: 2026-09-24
- **类型**: MODIFY（新增部署形态）
- **状态**: in_progress
- **影响 spec**: `alysia-console`（补 §1 生产形态）、`webui-system`（§6 静态托管改为可切换）

## 动机（为什么做）

用户目标：**本地部署、打开、连接后端**。当前 `packages/console` 只能以 `next dev` 形态跑
（3000），并靠 `rewrites` 代理到 6185 —— 这是开发形态，要开两个进程、且不是最终部署形态。

生产形态应当是 `webui-system` §6 已有的模式：**Fastify 同源托管静态产物 + `/api/*`**，
一个进程、无代理、无 CORS。本 change 把这套搬到 `console`。

## 需求（做什么）

- [ ] `next.config.mjs` 条件化：`next dev` 保留 `/api` rewrites 代理；`next build` 走
      `output: 'export'` 静态导出（**实测二者不能共存**：export 下 rewrites 不生效并告警）
- [ ] `packages/server`：静态托管根目录可切换，服务模式优先 serve `console/out`，
      **桌面模式（Electron）保持 webui 不变**
- [ ] 路径映射支持 Next 多页导出：`/life` → `out/life.html`（**不是** `life/index.html`）
- [ ] MIME 表补 `woff2`（自托管字体）、`txt`（Next RSC payload）
- [ ] 未知路径：有 `404.html` 就用它（Next），否则回退 `index.html`（webui hash 路由行为）
- [ ] 根 `package.json` 加一键脚本
- [ ] 文档：`docs/HANDOFF.md` 更新本地部署步骤

## 设计决策（怎么做，含备选与取舍）

**决策 1：dev 与 build 用不同配置，而不是放弃 dev 代理**

`output: 'export'` 下 `rewrites` 不生效（实测告警）。备选是"干脆不要 dev 代理，dev 也同源"，
但那要求 dev 时 Fastify 已经在跑且已构建产物，热更新链路全断。否决。
选条件化：`NODE_ENV === 'development'` 给 rewrites，否则给 export。

**决策 2：服务模式 serve console，桌面模式 serve webui**

Electron 壳（`packages/desktop`）依赖 webui 的 SPA 形态（hash 路由 + Live2D 资源 + pet.html），
且 console 的聊天还是演示数据。直接在服务端全局切换会**静默弄坏桌面端**。
按 `IS_DESKTOP` 分流，两边都不受影响。

**决策 3：静态根目录由 bootstrap 显式传入，不在 server.ts 里猜**

`createWebuiApp` 增加 `staticDist?: string` 选项，由 `bootstrap.ts` 决定传什么。
好处：server.ts 保持"薄路由层"职责，路径决策集中在接线层，也便于测试。

**决策 4：优先 console 用「产物存在」判定，不存在则静默回退 webui**

`packages/console/out` 是构建产物（gitignore），未构建时不应 500。回退到 webui 保证
"没构建也能用"，并在日志里说明用了哪个前端。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**需改 doc**——`webui-system` §6 写死"托管 webui dist"，
      现在变为"按模式切换"。方向：doc 更新为可切换语义（不是 impl 迁就 doc）
- [x] 涉及 Web API？**不涉及**（不新增端点，只改静态托管）

## 风险

1. **`next build` 需要联网**：`next/font/google` 会在构建时下载 Google Fonts 并自托管为
   11 个 woff2。离线/受限网络下构建会失败。Docker 构建同理（但 console **不在**
   Docker 镜像里，暂不影响部署；将来纳入时要处理，见 Dockerfile 现有 npmmirror 做法）。

## 测试计划

- `pnpm --filter @alysia/console build` → 产出 `out/`，各页 `.html` 齐全
- 起 server（服务模式）→ `http://localhost:6185` 打开是新前端；`/life` `/dashboard`
  `/personality` 各自渲染对应页（**不是都显示首页**）；`/api/*` 同源可达
- 无 token → 401 → TokenGate 弹窗；填 token 后正常
- **回归：桌面模式（`IS_DESKTOP`）仍加载 webui**
- 未构建 `out/` 时服务端不 500，回退 webui 并有日志
- core / server / console 测试全绿

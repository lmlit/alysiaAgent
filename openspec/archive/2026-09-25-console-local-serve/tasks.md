# Tasks: console-local-serve

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `next.config.mjs` 条件化：`NODE_ENV=development` 给 rewrites 代理，否则 `output: 'export'`
- [x] `WebuiAuthOptions` 增加 `staticDist?: string`；产物不存在时回退默认并 warn
- [x] 静态托管候选链：原路径 → `<path>.html` → `<path>/index.html`（首尾斜杠都剥）
- [x] 未命中回退：有 `404.html` → 用它 + **状态码 404**；否则 `index.html` + 200（webui hash 路由不变）
- [x] MIME 补 `woff2` / `txt` / `map`
- [x] 防目录穿越改用 `dist + sep` 收口（旧写法 `/dist-evil` 会命中 `/dist`）
- [x] 畸形百分号编码 → 400，不 5xx
- [x] `bootstrap.ts` 按 `IS_DESKTOP` 分流：服务模式 serve console，桌面模式保持 webui
- [x] `bootstrap.ts` 用 `import.meta.url` 定位（ESM 无 `__dirname`，直接写会在运行时炸）
- [x] 根 `package.json` 加 `dev:console` / `build:console`

### ★ 顺带修复的既有 P0（原不在计划内，是本次目标的拦路虎）

- [x] **鉴权钩子拦下所有请求**（应为只守 `/api/*`）——浏览器打开 `/` 直接 401，
      前端页面加载不出来。原实现与其文档注释、与 `server-hardening` §6 第 6 条均不符
- [x] `/api/health` 精确匹配 → 改为先剥 query（`/api/health?probe=1` 原本会被误拦）

### 测试

- [x] `tests/webui-auth.test.ts` 补 4 个用例：静态路径不被拦 / 未配 token 静态仍可访问 /
      带 query 的 `/api/*` 仍受保护 / 带 query 的 health 仍豁免
- [x] 新增 `tests/webui-static.test.ts`（13 用例）：Next 路径映射、尾斜杠、
      404 语义、SPA 回退、MIME、缓存头、目录穿越、畸形编码
- [x] 测试**抓到真 bug**：`/life/` 带尾斜杠会 404（真实 Next 导出不生成 `life/index.html`）→ 已修

## Apply 任务

- [x] `openspec/specs/alysia-console/spec.md`：§1 补生产形态、新增 §7 托管契约 + §7.1 鉴权边界
- [x] `openspec/specs/webui-system/spec.md` §6：标注托管可切换
- [x] `openspec/specs/server-hardening/spec.md` §6.1：记录钩子范围修复（原实现违反本节第 6 条）
- [x] 更新 `docs/HANDOFF.md`
- [x] 回归：626 passed（+17），7 包全构建

## 验收记录（2026-09-24）

在**服务模式**下起 server，`http://localhost:6185` 直开：

| 项 | 结果 |
|---|---|
| `/` `/life` `/dashboard` `/personality` `/chat` `/desktop` | ✅ 全 200，且**各自渲染对应页面**（用页面特征串逐页验证，不是都返回首页） |
| `/life/` `/dashboard/` `/personality/`（尾斜杠） | ✅ 200 命中正确页面 |
| 未知路径 `/no-such-page` | ✅ 404 + Next 404 页 |
| `/_next/static/*.js` `*.css` `*.woff2` | ✅ 200，MIME 正确（`font/woff2`） |
| 无 token `/api/life` | ✅ 401 |
| `/api/health`（含带 query） | ✅ 200 豁免 |
| 带 token `/api/life` | ✅ 200 真实数据 |
| **回退**：临时移走 `out/` 重启 | ✅ 日志 `前端: webui (Vue)` + 说明原因，`/` 出 webui，不 500 |

## 未覆盖 / 留给后续

- **桌面模式（`ALYSIA_DESKTOP=1`）未在真机跑过** —— 代码路径是"不传 staticDist → 默认 webui"，
  与改动前一致（回归风险低），但没有实际启动 Electron 验证
- 页面 `<title>` 目前全站同一个（全局 metadata）—— 各页应有自己的标题，属独立小改动
- 构建依赖网络（`next/font/google` 下载字体），离线/受限网络构建会失败

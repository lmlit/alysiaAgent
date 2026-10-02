# Tasks: remove-packages-webui

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 前置核查结论（2026-10-02 实测，proposal 要求"别信文档，去读代码"）

| 提案列的耦合点 | 实测现状 | 结论 |
|---|---|---|
| 1. `server.ts` 的 `defaultDist` | `src/webui/server.ts:127-132` 确实在：不传 staticDist → 回落 `packages/webui/dist`；`:161` 的 `existsSync` 门控失败 = **整个静态路由静默不注册**（全站 404 且无一行日志） | ✅ **已改（P0）** |
| 2. `IS_DESKTOP` 分流 | 已不在 `bootstrap.ts`（10-01 模块化搬到 `modules/webui.ts:58`）。★ 复核更正：`ALYSIA_DESKTOP=1` **确实有人在用**——`.video-demo/start-server.ps1:37`（首轮审计漏了未跟踪目录，误判为死分支）；语义是「跳过 IM 适配器」，前端托管只是搭车 | ✅ **已改（去门）**：webui 已删，所有模式统一托 console |
| 3. webui 侧 Live2D / 模型 / 署名残留 | **与提案记载不符**：webui 包内**没有任何** NOTICE / LICENSE；署名在 `packages/console/public/models/cyrene/NOTICE.md` + `cyrene-assets/README.md`。模型文件 console 已全套收编（同名、`model.moc3` md5 一致，贴图 8192²→2048² 降采样）；**8192² 原图在 `cyrene-assets/live2d/cyrene/` 有同尺寸备份**（9,007,035 字节，字节数一致） | 无需动作 |
| 4. `webui-system` spec 去向 | 67 行；§7 Live2D §8 Electron 已被历史 change 划掉。**唯一独有记录 = §6 的 `GET /api/stickers/file/:name`**（`docs/Web-API-Design.md` 未登记这条） | ✅ 已补登记进 Web-API-Design → spec 标 `frozen` |
| 5. config.yml 的 webui 键 | 根 `config.yml` / `config.example.yml` **零 webui 键**；`packages/server/config.yml` 只有 `webuiToken`（console 鉴权在用） | 无需动作（保留） |

**实测补充（提案未列）**：删包失去 7 项"服务端端点仍在、但从此无界面"的管理能力
（世界书删 / 模板增删 / 角色切换导入 / 知识导入删 / 人格 adjust / 头像上传 / 表情包渲染）。
经查无自动化调用方、入口只有旧前端自身 → 属"已废弃但仍是唯一入口"，登记进「遗留」表，不在本 change 补建界面。

## 实现任务

- [x] `packages/server/src/webui/server.ts`：删 `defaultDist` 与 webui 回落；`dist` 改 `string | null`；
      产物缺失 → **静态路由不注册 + 显式 warn**（禁止静默）；同步改 interface 注释（:51-55）与 :179 措辞
- [x] `packages/server/src/modules/webui.ts`：去 `!isDesktop` 门与「回退 webui」文案；
      缺 console 产物 → `logger.warn` 并给出构建命令（原为 info+错误指引）
- [x] `packages/server/tests/webui-static.test.ts`：改「回退默认前端」用例 →
      「不注册静态路由（404）+ `/api/health` 仍 200」；补「完全不传 staticDist」用例；describe 更名
- [x] `git rm -r packages/webui`（64 个跟踪文件）+ 清未跟踪的 `dist/`、`node_modules/`
- [x] `pnpm install` 刷新 `pnpm-lock.yaml`（`packages/webui:` importer 块已移除）
- [x] 同步文档与 spec（见下）

## 实测验收

| 项 | 结果 |
|---|---|
| `pnpm -r build` | ✅ 5 包全过（core / server / console / dsh-adapter / dsh-console），tsc 无错 |
| server 测试 | ✅ 13 文件 / **224 用例**全绿（webui-static 14 条，含新增 2 条） |
| 全量 `vitest run`（不含 E2E） | ✅ **85 文件 / 990 用例**全绿（基线 965 → 990） |
| 起本地 server（真启动 + curl） | ✅ 日志 `前端: console (Next.js)`（旧为 `webui (Vue)`）；`/` `/chat` `/dashboard` `/life` `/personality` 全 200；未知路径 **404**（带 404 页，非白屏）；静态资源全 200（`_next` chunk / Live2D 运行时 207KB / 模型 / 贴图 904KB / NOTICE）；`/api/{health,life,sessions,profile,persona,stats}` 全 200，`/api/stats` 1641 字节 = P3 模块化验收基线**一字不差** |
| 缺产物路径（不注册静态路由） | ✅ 由单测覆盖：`/` → 404 且 `/api/health` → 200（"没前端 ≠ 服务挂了"） |
| `grep -rn "webui/dist"` | ✅ 仅剩历史归档/迁移文档与本次新增注释，活代码零命中 |
| ⚠️ 环境坑（非本次引入） | 本机默认 shell 是 **Node 20**（`better-sqlite3` 报 NODE_MODULE_VERSION 115/137、vitest 配置加载 `ERR_REQUIRE_ESM`）——**本仓必须用 Node 24**（`E:\nodejs24`）。已补进 HANDOFF 环境速查 |

## 文档同步清单

- [x] `openspec/specs/index.md`：webui-system 行 → `frozen`；backlog 移除本 change；`webui-visual-redesign` 注记收尾
- [x] `docs/HANDOFF.md`：:126 / :517-518 / :634 / :707 + 「顺带查实三件事」#2 复核更正
- [x] `CLAUDE.md`：:83 / :89 / :140（Next 第 5 条标记完成；说明 server 侧 `webui/` 路由层保留）
- [x] `packages/console/README.md:3`（"取代 webui（待废）" → "已于 2026-10-02 删除"）
- [x] `docs/Web-API-Design.md`：消费方收敛为 console 唯一；补登记 `GET /api/stickers/file/:name`
- [x] `openspec/changes/webui-visual-redesign/proposal.md`：状态行标 superseded
- [x] 历史文档加"对象已删"横幅：`docs/WebUI-PRD.md` / `docs/dsh-migration-guide.md` / `docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md`

## Apply 任务（实现完成后）

- [x] 合并三份 spec delta 到 `openspec/specs/{webui-system,alysia-architecture,alysia-console}/spec.md`
- [x] 更新 `openspec/specs/index.md`（状态 / 最后变更列）
- [x] 归档到 `openspec/archive/2026-10-02-remove-packages-webui/`

## 遗留（本 change 不做，登记在案）

| 项 | 说明 | 去向 |
|---|---|---|
| 7 项管理能力降级为 API-only | 世界书删 / 生活模板增删 / 角色切换导入 / 知识导入删 / 人格手动 adjust / 头像上传 / 表情包渲染——端点全在，界面没了 | 表情包渲染已在 `CLAUDE.md` Next 列表；其余待用户决定是否在 console 补管理页 |
| `@alysia/server/webui` 死导出 | `packages/server/package.json:8` 无消费者（指向 server 自己的路由层，非旧包） | 可选清理，非本次范围 |
| `webui-visual-redesign` change | 对象已删；proposal 已标 superseded，仍留在 `changes/`（本仓无 superseded 归档先例，沿用"文本登记"惯例） | 本 change 内已标注 |

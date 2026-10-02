
> 主 spec:docs/WebUI-PRD.md 为产品文档;本 spec 记录已实现的系统契约。
>
> ★ **2026-10-02 冻结（change: remove-packages-webui）**：`packages/webui` 已整体删除，
> 本 spec 状态 → `frozen`，只作历史参考。现行前端为 `packages/console`，契约见 `alysia-console`。
> 本文件中**仍然活着**的只有 §6 的 `GET /api/stickers/file/:name`（server 侧路由，与包无关）。

## 1. 形态

~~Vue 3 + Vite + Pinia + vue-router(hash)SPA,`packages/webui/`;
生产由 server Fastify 同源托管 dist,dev 用 vite(5173)代理 /api → 6185。
一期聊天模式:M1-M3(骨架/管理面板/聊天视图);M4 Electron 壳 + Live2D 见下一 change。~~

★ **2026-10-02 整包删除**（change: remove-packages-webui）——静态托管改为只托管 console 产物。

## 2. 主题系统

- `src/theme/tokens.css`:`--aw-*` 语义别名(星穹紫金 stardust 默认/晨光 dawn/午夜 midnight),
  `data-theme` 切换 + localStorage;组件只消费别名,不写字面颜色
- 三栏布局:侧栏(导航模块表)/顶栏(连接状态/角色/亲密度/主题切换)/内容区

## 3. 扩展点(PRD §8)

- `src/modules.ts`:导航模块表(id/title/icon/path/view)——二期编程模式加一行 + views/programming/
- `src/api/modules.ts`:按域分组 API;二期新增 programming.ts
- 通用组件池 `src/components/common/`:卡片/JSON/确认删除/空态/标签/表格 + useAsync

## 4. 管理面板(10 页)

画像/人格(参数 ±0.05 调整 + 记忆旋钮滑块)/生活(快照+事件流)/世界书(删除,source 标记)/
生活模板(删除)/角色(切换+导入 JSON)/知识库(导入+删除)/会话/Token 统计/表情包

★ 2026-10-02 随包删除：以上界面全部消失。**服务端端点全部保留**（`/api/*` 未动），
但 7 项能力自此**只有 API、没有界面**（世界书删 / 模板增删 / 角色切换导入 / 知识导入删 /
人格手动 adjust / 头像上传 / 表情包渲染）——登记见 change `remove-packages-webui` 的遗留表。

## 5. 聊天视图

- 会话侧栏:webui: 前缀过滤,新会话/切换
- 消息流:历史(limit 100 倒序),加载更早(before 游标)
- 流式:POST /api/chat/stream SSE(chunk 逐块/done/aborted/error 帧);
  停止按钮 = AbortController 断开
- 表情包:[表情包:名字] → `GET /api/stickers/file/:name` 渲染贴图(404 静默隐藏)

## 6. 服务端集成

- ~~静态托管:dist/index.html(hash 路由);产物缺失静默跳过~~
  ★ 2026-10-02：改托管 console 产物（`packages/console/out`）；**产物缺失不再静默**——
  静态路由不注册 + 显式 warn（静默不注册 = 全站 404 且无日志，见 `alysia-console` §7）
- ★ 2026-09-24(console-local-serve):托管**可切换**——服务模式优先 `packages/console/out`,
  ~~桌面模式(`ALYSIA_DESKTOP=1`)仍托管本包 dist~~ ★ 2026-10-02 随本包删除
  （前端托管不再看 isDesktop；`ALYSIA_DESKTOP=1` 保留但语义只剩「跳过 IM 适配器」，
  使用者：`.video-demo/start-server.ps1` 与本地 UI-only 实例）。契约见 `alysia-console` §7;
  鉴权边界修复见 §7.1(钩子只守 `/api/*`,静态资源公开)
- `GET /api/stickers/file/:name`:findSticker → 读文件返回(带 Content-Type/Cache-Control)
  ★ 2026-10-02：本 spec 曾是这条端点的唯一书面记录，已同步补进 `docs/Web-API-Design.md`（端点在，故保留本节）

## 7. ~~Live2D~~（2026-08-15 建，**2026-09-25 已迁出**到 console，change: migrate-live2d-to-console）

- 模型 `public/models/cyrene/`（Cubism4，9.1MB；许可:是依七哒授权署名，不可商用）
  → 已拷至 `packages/console/public/models/cyrene/`
- 渲染层 `src/live2d/`（manager/mouth-sync/interaction/expression-reset/actions）
  → 已迁至 `packages/console/lib/live2d/`；**`speaking-motion.ts` / `focus.ts` 是死代码，未搬**
- `Live2DCanvas.vue` → 改写为 `console/components/live2d/live2d-canvas.tsx`（React）
- `pet.html` + `pet.ts` 桌宠页 → **随 Electron 一起失去宿主**，不再需要
- 依赖 pixi.js 7.3 + pixi-live2d-display + live2dcubismcore.min.js → 已在 console 侧声明

**迁移中发现的 7 个问题见 `alysia-console` §7.2**（GBK 编码文件、死的 Pixi 配置项、
Cubism 时序、StrictMode 复用 canvas 丢 context、`window` 尺寸假设…）。
本包现已无 Live2D 使用者，**已于 2026-10-02 整体删除**（change: remove-packages-webui）。

## 8. ~~Electron 壳~~（2026-08-15 建，**2026-09-25 已删除**，change: drop-electron-desktop）

- ~~主进程 = 本地完整实例:AlysiaCore(本地 userData db,codeMode=true)+ createWebuiApp(127.0.0.1 随机端口)~~
  ★ 该描述**在删除前就已与实现不符**：实际是 fork `packages/server/dist/bootstrap.js`
  （`cwd` = server 目录），**固定端口 6185**、**共用 `packages/server/data`**，非独立 userData db。
- 删除理由：用户决定砍掉桌面端；它 load 的 `/#/chat`（hash 路由）与 `/pet.html` 都是本包独有，
  与 `packages/console` 不兼容；且与本地 server 同端口同库（同开时子进程绑不上端口，静默失败）。
- 连带删除：`packages/desktop/`（4 文件）、桌宠页 `pet.html` 的宿主。
- **保留**：`ALYSIA_DESKTOP` / `IS_DESKTOP` 开关本身（见 `alysia-console` §7），
  语义降级为"跳过 IM 适配器与主动推送的 UI-only 本地模式"，不再有 Electron 壳去设置它。
- `play_live2d_action` 待办**未消失**，随 Live2D 迁移一并处理（见 `alysia-console`）。

## 9. ~~整包删除~~（**2026-10-02 已删除**，change: remove-packages-webui）

- `packages/webui/` 64 个跟踪文件整体 `git rm`（src/ 11 视图 + live2d/ 7 文件 + public/models 9.1MB）
- 三个删除约束此前已全部解除：Electron 壳（drop-electron-desktop）、
  Live2D（migrate-live2d-to-console）、静态托管切换（console-local-serve）
- **资产**：8192² 贴图原图在 `cyrene-assets/live2d/cyrene/` 有同尺寸备份；
  console 侧为 2048² 降采样 + `NOTICE.md` 署名（本包内从无 NOTICE）
- **保留**（与旧包无关、console 正在消费）：`webui:` / `webui:private:` 会话前缀、
  `webuiToken` 配置键、`localStorage['webui_token']` 键名、`al:webui` 模块名、
  `server/src/webui/` Fastify 路由层

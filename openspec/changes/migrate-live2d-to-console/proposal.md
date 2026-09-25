# Change Proposal: migrate-live2d-to-console

## 元信息

- **日期**: 2026-09-25
- **类型**: NEW（功能迁移）
- **状态**: proposed（**待定：新前端的呈现形态**，见「未决」）
- **影响 spec**: `alysia-console`（新增 Live2D 节）、`webui-system`（§7 迁出后标记）
- **前置**: `drop-electron-desktop`（已完成）

## 动机（为什么做）

用户决定：**Electron 砍掉、Live2D 迁往 console**。迁完即可整体删除 `packages/webui`。

现状：console 的角色形象是**纯 SVG 暖光球**（`components/xilian-avatar.tsx`，无外部资源）。
Live2D 目前只在 webui 里，伴随 webui 一起待废。

## ★ 关键发现：迁移量远小于听起来

```
packages/webui/src/live2d/*.ts      859 行  → ✅ 零 Vue 依赖（纯 TS + PixiJS + DOM），可**原样搬**
packages/webui/src/components/live2d/Live2DCanvas.vue  103 行 → 唯一 Vue 包装层，改写为 React
packages/webui/public/models/cyrene/  9.1MB → 资源拷贝
依赖: pixi.js ^7.3.0 + pixi-live2d-display 0.5.0-beta + live2dcubismcore.min.js(全局脚本)
```

模块清单（全部框架无关）：
`manager.ts`(317) / `interaction.ts`(135) / `focus.ts`(113) / `mouth-sync.ts`(88) /
`actions.ts`(85) / `speaking-motion.ts`(64) / `expression-reset.ts`(57)

当前对外接口（`window.live2d`）：
```ts
{ playAction(aliasOrTarget): Promise<boolean>, startMouth(ms), stopMouth(), dispose() }
```

## 需求（做什么）

- [ ] 拷 `webui/src/live2d/` → `console/lib/live2d/`（**原样，不改一行**）
- [ ] 写 `components/live2d/live2d-canvas.tsx`（React 版包装，替换 Vue 的 103 行）
      —— 用 `useRef` + `useEffect` 管理 canvas 生命周期；**必须处理 StrictMode 双挂载**
      （PixiJS 重复初始化会泄漏 WebGL context）
- [ ] 拷 9.1MB 模型 → `console/public/models/cyrene/`
- [ ] console 加依赖 `pixi.js@^7.3.0` + `pixi-live2d-display@0.5.0-beta`
- [ ] 载入 `live2dcubismcore.min.js`（Cubism 运行时，全局脚本）——
      Next 下用 `<Script>` 或 layout 里 `beforeInteractive`，**不能在组件里 import**
- [ ] 保留 `window.live2d` 对外接口（`play_live2d_action` 工具与后续 TTS 口型要用）

## 设计决策（怎么做，含备选与取舍）

**决策 1：859 行原样搬，不"顺便重构"**

它们与框架无关，重写只会引入回归。React 化的边界严格限制在包装层。

**决策 2：写独立 `<Live2DCanvas>`，不把 PixiJS 塞进现有组件**

暖光球（SVG）继续承担**小尺寸头像位**（消息气泡 34px、侧栏、各页 hero）——
用 3D 模型渲染 34px 头像是荒谬的。Live2D 只出现在**大尺寸位置**，两者分工共存。

**决策 3：`live2dcubismcore.min.js` 必须全局加载**

它是 Cubism 官方运行时，`pixi-live2d-display` 依赖其全局对象。
webui 放在 `index.html`；Next 里对应 `app/layout.tsx` 的 `<Script strategy="beforeInteractive">`。

## 已决（2026-09-25，用户拍板）

**决策 A：Live2D 进各页 hero 区，替换大尺寸暖光球。**

| 位置 | 现状 | 迁移后 |
|---|---|---|
| `/life` hero | SVG 球 180px | **Live2D** |
| `/dashboard` 状态卡 | SVG 球 130px | **Live2D** |
| `/` landing hero | SVG 球 200px | **Live2D** |
| 其余（消息气泡 34 / 顶栏 44 / CTA 120 / 侧栏 36） | SVG 球 | **保持 SVG** |

依据：小尺寸头像位塞 3D 模型是荒谬的；暖光球继续承担**所有小尺寸**场景，
Live2D 只出现在**大尺寸**位置。两者分工共存，不是替换关系。

**决策 B：`soul.md` 的「Live2D 桌面空间」另开 change 改。**

Electron 已砍，"桌面空间"与她现在的真实处境（浏览器里的一个角落）不符，
但改 persona 会影响她的自我叙述与输出语气，按 OpenSpec 流程单独走，不夹带在本 change。

**决策 C：本次只搬"能动"，交互待办不并做。**

`alysia-todo-live2d-states` 挂着的 `play_live2d_action` 工具 + 输出驱动状态切换 +
小人帮助弹层，属后续 change。本次目标是**让 Live2D 在新前端活着**（能渲染、能点、
`window.live2d` 接口可用），为那些功能铺好地基。

## 对账方向确认

- [x] 是否与现有 spec 冲突？`webui-system` §7 描述 Live2D 在本包内 ——
      迁移后该节标记"已迁出 console"
- [x] 涉及 Web API？**不涉及**（Live2D 纯前端；`play_live2d_action` 若要做工具则是 core 侧，
      属后续 change）

## 风险

1. **9.1MB 模型进 console 仓库**：console 的 `out/` 会从 1.6MB 涨到 ~11MB。
   部署到服务器时镜像同步变大（可接受，但要知情）。
2. **授权**：模型为「是依七哒授权署名，不可商用」（`webui-system` §7）——迁移不改变授权，
   但要注意别把它带进公开分发。
3. **StrictMode 双挂载**：PixiJS 初始化两次会泄漏 WebGL context 并可能黑屏。
   React 侧必须写对清理逻辑（这是 Vue 版没有的坑）。
4. **Cubism 运行时的加载时序**：全局脚本必须在组件初始化前就绪，否则
   `pixi-live2d-display` 抛错。需要显式的就绪等待，不能靠时序运气。

## 测试计划

- React 包装层：挂载/卸载/重挂载不泄漏（StrictMode 下 canvas 只有一个）
- 无头 Edge 截图：模型渲染出来（不是空白 canvas）
- `window.live2d.playAction('...')` 可调用并返回
- 暖光球位置不受影响（小尺寸头像仍是 SVG）
- 全仓构建 + 测试；`out/` 体积记录

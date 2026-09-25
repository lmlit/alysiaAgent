# Tasks: migrate-live2d-to-console

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] 拷 `webui/src/live2d/*.ts` → `console/lib/live2d/`
- [x] 拷模型 `models/cyrene/`（9.1MB）+ `live2dcubismcore.min.js`（207KB）→ `console/public/`
- [x] console 加依赖 `pixi.js@^7.3.0` + `pixi-live2d-display@0.5.0-beta`
- [x] `components/live2d/live2d-canvas.tsx`（React 包装，替代 Vue 的 103 行）
- [x] `components/xilian-figure.tsx`（Live2D + 暖光球退化）
- [x] 接进三处 hero：`/life`(320) `/dashboard`(230) `/`(380)；其余小尺寸保持 SVG 球

## ★ 迁移中发现的 7 个问题（「原样搬」是错的）

| # | 问题 | 真相 |
|---|---|---|
| 1 | **`focus.ts` / `speaking-motion.ts` 是死代码** | 全仓库无人引用（连 pet 窗口都没用）。859 行里实际活的只有 **682 行** —— 已删死代码，**不搬** |
| 2 | **`expression-reset.ts` 是 GBK 编码** | `.ts` 文件里混了 GBK 字节（`b1 ed c7 e9` = 「表情回正」）。Vite 容忍，**Turbopack 直接报 invalid utf-8**。已定点修复（原 webui 文件同样坏，一并修了） |
| 3 | **`manager.ts` 的 `transparent: true` 不存在于 Pixi v7** | v6 遗留，被静默忽略（真正生效的是 `backgroundAlpha: 0`）。**webui 从不类型检查**（`build` 脚本是裸 `vite build`，不跑 tsc）所以一直没暴露 |
| 4 | **Cubism 运行时必须在模块 import 之前就绪** | `pixi-live2d-display/cubism4` 在**模块求值阶段**检查全局 `Live2DCubismCore`。"先 import 再在 effect 里加载"**必然失败**。抽出 `lib/live2d/runtime.ts`，由 `XilianFigure` 保证顺序：装运行时 → 再动态 import |
| 5 | **StrictMode 复用 canvas 导致 context 被丢弃** | Pixi 的 `destroy()` 会调 `WEBGL_lose_context.loseContext()`；React 复用同一 DOM 节点 → 第二次挂载拿到**已丢弃的 context**，`getParameter(MAX_TEXTURE_IMAGE_UNITS)` 返回 **0** → Pixi 抛 `Invalid value of '0' passed to checkMaxIfStatementsInShader`。**canvas 改由 effect 自建**，每次挂载都是全新的 |
| 6 | **`applyZoom` 把 canvas 撑成整个浏览器窗口** | 原代码 `this.resize(window.innerWidth, window.innerHeight)` —— Electron 桌宠窗口的假设（窗口即容器）。浏览器里 window 是视口 → canvas 变 756×488 而容器只有 203×260，**画面上什么都不显示**。改为按容器尺寸 |
| 7 | **`baseScale` 有「绝不放大」上限** | 原 `Math.min(..., 1.0)` 是桌宠策略；hero 要填满。加 `fit` 选项，默认 `fill` |

**另**：容器比例实测调整 —— Cyrene 是 **Q 版模型**，可见包围盒 163×144（近方形），
按竖构图设比例会浪费高度。RATIO 0.78 → 0.88。

## 实测验收（2026-09-25）

用 CDP（Node 自带 WebSocket）拿浏览器 console + 量画布：

| 项 | 结果 |
|---|---|
| `/` `/life` `/dashboard` | ✅ `data-live2d="ready"`，canvas 存在 |
| `/chat` `/personality` | ✅ 无 Live2D（本就该没有） |
| canvas 尺寸 | ✅ 203×260，与容器一致（修复前 756×488） |
| 模型实际渲染 | ✅ 采样画布不透明像素 **22.5%**，包围盒 163×144 |
| WebGL 可用性 | ✅ 真 GPU（ANGLE/D3D11），**不是环境限制** —— 报错确实是代码问题 |
| 回归 | ✅ 674 passed |
| 构建 | ✅ 6 包全绿；`out/` 1.6M → **12M**（模型 9.1MB） |

## 新增的诊断手段（可复用）

- `--dump-dom` + `data-live2d={phase}` 属性：分清"没加载"和"静默退化"
- **CDP 探针**（Node 24 自带 WebSocket，零依赖）：抓浏览器 console、真实等待后截图、
  在页面里 eval（读 WebGL 参数 / 量画布的模型包围盒）
  —— 这套比"看截图猜"精确得多，排查 WebGL/渲染问题必备

## Apply 任务

- [ ] `openspec/specs/alysia-console/spec.md`：新增 Live2D 节（分工/失败退化/顺序约束）
- [ ] `openspec/specs/webui-system/spec.md` §7：标记「已迁出」
- [ ] 更新 `docs/HANDOFF.md`
- [ ] `alysia-todo-live2d-states` 的待办转到 console 语境

## 遗留 / 后续

- **`soul.md` 的「Live2D 桌面空间」** —— 用户决定另开 change 改（她的自我认知里还有 Electron
  时代的"桌面空间"表述，与实际不符）
- **`play_live2d_action` 工具 + 输出驱动状态切换 + 小人帮助弹层** —— 本次只搬"能动"，
  交互待办留后续（`window.live2d` 接口已就绪）
- **`packages/webui` 现在可以删了** —— 三个约束（Electron / pet.html / Live2D）全部解除，
  但需另开 change 走完整删除流程
- **`out/` 12MB** —— 部署到服务器时镜像会同步变大（知情接受）
- 小尺寸（消息气泡 34 / 顶栏 44）仍是 SVG 暖光球，**这是设计决定不是遗漏**

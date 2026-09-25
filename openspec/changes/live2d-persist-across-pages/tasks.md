# Tasks: live2d-persist-across-pages

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `lib/live2d/shared-instance.ts`：模块级单例（canvas + manager + 状态订阅）
      —— 放模块而非 React ref，才能**跨路由不重建**且**扛住 StrictMode 双挂载**
- [x] `components/live2d/live2d-layer.tsx`：持久层，挂 root layout
- [x] `XilianFigure` 改为"注册槽位"，不再自建 canvas
- [x] `Live2DManager.fitTo(w,h)`：换页只重算缩放，不重载模型
- [x] 删掉被取代的 `live2d-canvas.tsx`；`window.live2d` 接口迁到单例
- [x] canvas 无槽位时"停车"（隐藏不销毁）—— `/chat` `/personality`

## ★★ 三次尝试，两次撞墙（过程如实记录）

### 尝试 1：把 canvas 搬进槽位（appendChild / Portal）→ **崩了**

```
NotFoundError: Failed to execute 'insertBefore' on 'Node':
  The node before which the new node is to be inserted is not a child of this node.
NotFoundError: Failed to execute 'removeChild' on 'Node': ...
```

把 React 渲染出来的节点搬走，React 就**丢失了对它父节点的认知**，之后插入/删除兄弟节点时抛错，
整页白屏。Portal 换容器同病（容器是渲染时读的，不受支持）。

**教训**：React 管的 DOM，不要让别的代码去改它的父节点。

### 尝试 2（最终方案）：canvas 留在原地，用 CSS 定位到槽位上方

槽位只提供矩形 → 换算成文档坐标 → `transform: translate()` + 尺寸。
React 全程只认自己那份 DOM 结构，永远不会错位。

### 尝试 3 途中的两个坑

**坑 A：context value 每次渲染都是新对象 → 无限重渲染**

```
Maximum update depth exceeded
```
消费方 effect 依赖整个 ctx 对象 → layer 一渲染就重注册 → `setSlotTick` → layer 再渲染 → ♾️。
表现为**页面卡死、连导航链接都点不动**。
修：`useMemo` 化 provider value + 消费方依赖**稳定的函数引用**而非 ctx 对象。

**坑 B：`model.width` 是"已缩放后"的宽度 → 误差指数放大**

`fitTo` 里用 `this.model.width` 当分母算缩放，但 Pixi 的 `.width` 返回的是**已应用 scale 之后**的边界。
每次按新容器重算都在上一次结果上再乘一遍 —— 200ms 一次的复测循环把模型放大成一个特写。
修：加载完成、scale 还是 1 时**缓存未缩放基准尺寸**（`modelBaseWidth/Height`），所有缩放以它为分母。

## ★★ 追加：贴图瘦身（这才是用户真正看到的问题）

用户反馈「感觉没有变化」——**属实**。上面那套只消除了**换页重复**的代价，
**首屏那次「球 → 昔涟」照旧**，而用户看的正是首屏。

根因量出来了：

```
texture_0.png:  8192 × 8192   8.59 MB
实际展示尺寸:   约 334 × 380 px      → 每个方向超采样 24 倍
```

加载的 1.8s 基本全花在解码这张 8K 图上，而它只显示在 380px 的框里。

**处理**：用 Windows 自带 `System.Drawing`（零安装）把贴图降到 **2048²**（`convert` 是
Windows 的磁盘转换工具，**不是 ImageMagick**，差点踩坑）。模型 json 只按**文件名**引用贴图、
无尺寸字段，且 Cubism 用归一化 UV → 替换尺寸安全。

| | 之前 | 之后 |
|---|---|---|
| 贴图 | 8192² · 8.59 MB | **2048² · 0.86 MB**（像素少 16 倍） |
| 模型目录 | 9.1 MB | **1.4 MB** |
| 前端产物 `out/` | 12 MB | **3.6 MB** |
| 首屏 loading → ready | 1.8 s | **0.68 s**（快 2.6 倍） |

**画质已验证**：2× DPI 截图确认细节清晰（发丝/翅膀/配饰都在）。2048² 对 380px 展示仍是
5 倍超采样。

**原图备份**：`E:\workSpace\.texture-orig.png`（webui 里那份 8192² 原图仍在，可随时回退）。

## ★★ 追加 2：去掉加载期占位球（用户决定）

暖光球原先是**加载占位符**（我当初想"别留空白框"）。用户去掉它 —— **判断是对的**：

> 占位符应当是**同一个东西的粗糙版**（骨架屏之于内容），而不是**另一个东西**。
> 球和昔涟形状完全不同，先摆球再换成她，看起来像"被换掉了"而不是"加载好了"。

改动：`XilianFigure` 的 loading 阶段**不再渲染任何东西**（尺寸照旧占住 → 不引起布局跳动）。
暖光球**只保留在 fallback 分支** —— 那是"Live2D 真挂了"的兜底形象，不是占位符。

实测（临时移走模型资源验证兜底）：

```
+0.44s  loading,  orb=0    ← 加载期留空
+1.82s  fallback, orb=1    ← 模型真挂了才显示暖光球
```

## 实测验收（2026-09-25）

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 首次 `/life` | 2.0s 到 ready | 2.0s（首屏仍需等一次，模型 9MB） |
| 导航 → `/dashboard` | **重建**：canvas 1→0→1，~500ms，暖光球闪现 | ✅ **0 模型请求，状态一直 ready**，无闪现 |
| 导航 → `/` | 同上重建 | ✅ 0 请求 |
| 切 `/chat`（无槽位） | 重建 | ✅ canvas 保留、透明度 0 停靠；回 `/life` 秒回 |
| 三页模型位置 | — | ✅ 截图确认各自 hero 位置正确 |
| 回归 | — | ✅ 674 passed，6 包构建，`out/` 12M |

## Apply 任务

- [ ] `openspec/specs/alysia-console/spec.md` §7.2：补"跨页持久化"约束与两种禁忌做法
- [ ] 更新 `docs/HANDOFF.md`
- [ ] 回归 + 构建

## 遗留

- **首屏仍需等 2s** —— 本次只消除"重复"代价。要连首屏也快，得预热（应用启动就开始加载）
  或给贴图瘦身（9.1MB 是瓶颈，属独立课题）
- **布局稳定期靠 200ms × 3s 轮询复测**：异步数据到达会撑动 hero，ResizeObserver 抓不到
  "位置变了但尺寸没变"。这是当前方案最脆的一环 —— 若发现错位，优先怀疑这里
- 模型点击交互（9 命中区）已随 canvas 一起保留，但**未实测点击**（`pointer-events` 已开）

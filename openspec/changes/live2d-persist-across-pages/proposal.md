# Change Proposal: live2d-persist-across-pages

## 元信息

- **日期**: 2026-09-25
- **类型**: MODIFY（渲染架构）
- **状态**: in_progress
- **影响 spec**: `alysia-console` §7.2
- **前置**: `migrate-live2d-to-console`

## 动机（为什么做）

用户实测反馈：「为啥是先展示的球再变成昔涟」。

**实测确认这是真问题**（第一次探针看错了，第二次才量准）：

```
首次 /life:        ready,  canvas=1
点击导航 +300ms:   loading, canvas=0   ← 完全卸载重建
        +800ms:   ready,   canvas=1   ← 重新加载
模型请求: Cyrene.model3.json ×4, model.moc3 ×2   ← 确实重新请求
```

每次换页：**Pixi 实例销毁重建 + 模型重新加载（贴图 9MB）+ 一次暖光球闪现**，约 500ms。

## 需求（做什么）

- [ ] `Live2DProvider`（挂在 **root layout**，覆盖所有页面含 landing `/`）：
      持有一个 Pixi 实例 + canvas，**跨路由不销毁**
- [ ] canvas 用 `createPortal` 搬进"当前活跃槽位"；无槽位时挪到隐藏的停车位
      （**不是卸载** —— 卸载才丢 context）
- [ ] `XilianFigure` 改为"注册槽位"而非自建 canvas；尺寸变化时通知 provider
- [ ] `Live2DManager` 加 `fitTo(w,h)`：换页时容器尺寸变了要**重算缩放并居中**，不重载模型
- [ ] 首屏仍会等一次（2s）—— 顺带把加载起点提前到应用启动，别等 hero 挂载

## ★ 技术前提（已实测验证，不是假设）

**canvas 在 DOM 里换父节点，WebGL context 与已绘内容都保得住**：

```
afterReparent:  lost=false  same=true  px=51,153,229,255
afterDetach:    lost=false  same=true          ← 摘出文档再插回也不丢
afterReattach:  lost=false  same=true  px=51,153,229,255
```

这正是本方案可行、且**必须用 portal 搬家而不是卸载重建**的依据。
（若此前提不成立，整个方案要推翻 —— 所以先验证再设计。）

## 设计决策（怎么做，含备选与取舍）

**决策 1：Provider 放 root layout，不放 AppShell**

landing `/` 不走 `AppShell`，但它的 hero 也要 Live2D。放 root layout 才能覆盖全部 4 处。

**决策 2：用 portal 搬 DOM，不用"销毁+重建"**

见上。另外注意与既有约束的关系：`migrate-live2d-to-console` 踩过「StrictMode 复用 canvas
导致 context 被丢」——那条讲的是**复用一个被 Pixi destroy 过的 canvas**。
本 change 的 canvas 由 provider 持有一份、**从不 destroy**，是两回事。

**决策 3：尺寸变化走 `fitTo` 重算缩放，不重载模型**

`/life` 320 → `/dashboard` 230 → `/` 380，容器尺寸不同。模型资源不变，只是 scale 与 renderer size 变。

**决策 4：无槽位时"停车"而非卸载**

`/chat` `/personality` 没有 hero。此时把 canvas 挪到一个 `hidden` 容器里保住 context，
回到有 hero 的页面立刻可用。

## 风险

1. **换页瞬间的抖动**：旧 figure 卸载与新 figure 挂载之间，canvas 会短暂停在停车位。
   要观察是否有可见闪烁；必要时让旧槽位延迟释放。
2. **响应式**：窗口 resize 时槽位尺寸变，需要 ResizeObserver 同步。
3. **SSR**：canvas 与 portal 都只能在客户端，需 `useEffect` 内创建。

## 测试计划

- 实测（CDP）：首次 `/life` 2s → **换页到 `/dashboard` / `/` 应接近 0s 且模型请求为 0**
- 无头截图：三个 hero 位置模型都正确显示、尺寸适配
- 切到 `/chat`（无槽位）再切回 `/life`，模型应立即出现
- 回归：674 测试 + 全仓构建

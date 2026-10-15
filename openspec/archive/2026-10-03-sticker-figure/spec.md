# Spec 变更: sticker-figure

> **apply 说明**：本 change 改 `alysia-console` 的**两处**：
> ① **§7.2 Live2D 形象 —— 改写**（大尺寸形象的实现消费方式已被取代）；
> ② **§3 API 接入 —— 追加**贴纸两条路由。
>
> 锚点以 2026-10-15 的 `openspec/specs/alysia-console/spec.md` 为准
> （§3 起于 L45，§7.2 起于 L205）。
>
> ⚠️ 沿用 `add-theme-system` 起的改法：**不使用 `+`/`-` diff 标记**。

---

## 一、§7.2 改写：Live2D → 表情包轮换

**位置**：`alysia-console/spec.md` §7.2 整节。

**原文要点**（改写前）：大尺寸形象用 Live2D，配暖光球兜底；canvas 常驻 `Live2DLayer`；
跨页持久化见 §7.2.1。

**改写为**：

---

### 7.2 大尺寸形象（★ 2026-10-03 `sticker-figure` 取代 Live2D 消费方式）

**大尺寸形象 = 表情包轮换**：`XilianFigure` 从 `/api/stickers` 取列表，
每 **7 秒**随机换一张**与当前不同**的，**500ms** 交叉淡入。

**为什么换掉 Live2D**（轻月 2026-10-03）：
> 9MB 模型、加载期空白、跨页持久化的复杂度，换来的只是"会呼吸"；
> 而手边这套表情包本来就是她的脸，还带情绪和台词。
> **形象应该让人一眼认出是她，而不是让人等它加载完。**

**契约**：

1. **Live2D 代码保留，只是不再挂载**。`lib/live2d/`、`components/live2d/` 一行未动；
   root layout 不再包 `Live2DLayer`。**回退方式**：把 `<Live2DLayer>{children}</Live2DLayer>`
   放回 layout，并恢复 `xilian-figure` 的槽位注册（git 历史里有）。
   ★ 之所以连挂载都不要：没有消费方了，挂着只会**白白预载 9MB 模型 + 占加载期空白**。
2. **尺寸分工不变**（沿用 `migrate-live2d-to-console` 决策 A）：
   小尺寸（气泡 34 / 顶栏 44 / 侧栏 36 / CTA 120）→ `XilianAvatar`（SVG 暖光球）；大尺寸 → 本组件。
3. **不预载**：只给当前这张发请求（65 张 ≈ 8MB）。轮换变慢时再考虑预取下一张。
4. **加载期留空**，不放占位图 —— 沿用 2026-09-25 的决定：「占位符应当是同一个东西的粗糙版，
   而不是另一个东西」。靠**固定边长**防跳动。
5. **`prefers-reduced-motion` 下照常轮换、但不做淡入** ——
   该偏好的语义是"减少**动效**"，不是"禁止**内容**变化"。
6. **可观测**：`data-sticker={current ?? 'loading'}`（不标出来分不清"图还没到"和"本来就没有图"）。

### 7.2.1 跨页持久化 ⚠️ **保留但当前未启用**

该节描述的 `Live2DLayer` 槽位/portal 机制仍在仓库中（`live2d-persist-across-pages` 的实现未删），
但**当前无消费方**（root layout 不再挂载）。**重新启用 Live2D 时该节自动恢复效力。**

### 7.2.2 贴图尺寸约束 ⚠️ **保留但当前未启用**

同上 —— 约束的对象是 Live2D 贴图，随 Live2D 一并停用。

---

## 二、§3 追加：贴纸 API

**位置**：接在 §3 现有 API 列表之后。

以下为追加内容：

---

- **贴纸**（2026-10-03 `sticker-figure`）：
  - `GET /api/stickers` → `{ stickers: [{ name, path }] }`（`name` 即 `[表情包:名字]` 协议用的那个词）
  - `GET /api/stickers/file/:name` → 图片二进制（`<img src>` 直用）

  ★ **必须走 `/api/stickers/file/:name`，不要用响应里的 `path`**：
  `path` 是服务端登记值（形如 `/data/stickers/x.webp`），只有在
  **"服务端真把 `data/` 当静态目录挂出来"**的部署里才取得到 ——
  **实测本部署直接请求它 404**。`stickerApi.fileUrl()` 已把这条封在注释里。

  ★ 素材在服务端 `data/stickers/`，经世界书 `content_type='image'` 条目登记。
  **二创图不进公开仓库，也不进前端产物。**

---

## 明确不涉及

- **不改 §2 设计系统** —— 轮换用的都是语义变量
- **不改 §7.1 鉴权边界** —— 贴纸路由沿用现有 `/api/*` 鉴权
- **不修 `console-a11y-motion` 的 17 处动画** —— 只处理本 change 引入的淡入
- **不做 `[表情包:名字]` 渲染 / 管理入口 / hero 随机策略** —— 归 `improve-sticker-system`

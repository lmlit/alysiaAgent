# Change Proposal: sticker-figure

## 元信息

- **日期**: 2026-10-03（代码先落地，**2026-10-15 补立案**）
- **类型**: MODIFY（大尺寸形象实现替换 + 新增贴纸 API 消费）
- **状态**: archived（代码已实现并通过 `tsc`；待补 spec 合并与归档）
- **影响 spec**: `alysia-console`（**§7.2 Live2D 形象 → 改为表情包轮换**；§3 API 接入新增贴纸）
- **补立案原因**: 与 `code-mode-entry` 同批，代码注释自称 `change: sticker-figure`，
  但只被 `improve-sticker-system` 的 proposal **引用过一句**，自身从未立案。
- **★ 取代关系**: 本 change **取代** `migrate-live2d-to-console` 与 `live2d-persist-across-pages`
  的**消费方式**（不是删它们的实现）——见设计决策 1。

## 动机（为什么做）

轻月 2026-10-03 的判断：

> 「9MB 模型、加载期空白、跨页持久化的复杂度，换来的只是"会呼吸"；
> 而手边这套表情包本来就是她的脸，还带情绪和台词。
> **形象应该让人一眼认出是她，而不是让人等它加载完。**」

代价账很直白：Live2D 要 9MB 模型下载、要跨页持久化一整套槽位/portal 机制
（`live2d-persist-across-pages` 就是为它立的）、加载期还是空白。而表情包是**已有的资产**
——`data/stickers/` 里 65 张二创图，本来就是她的形象，且带情绪与台词。

## 需求（做什么）

- [x] `XilianFigure` 由「Live2D 槽位注册」改为**表情包轮换**
      —— 每 7s 随机换一张**与当前不同**的；500ms 交叉淡入；仅一张时不轮换
- [x] root layout **不再挂载 `Live2DLayer`**（`{children}` 直接渲染）
- [x] `live2d` 相关代码**原样保留**（`lib/live2d/`、`components/live2d/` 一行未动）
- [x] 新增 `stickerApi.list()` / `stickerApi.fileUrl()`（`lib/api/modules.ts` + `types.ts`）
- [x] **只给当前这张发请求**，不预载 65 张
- [x] 尊重 `prefers-reduced-motion`：照常轮换但**不做淡入**
- [x] 固定边长占位，换图不引起布局跳动
- [x] 可观测：`data-sticker={current ?? 'loading'}`

## 设计决策（怎么做，含备选与取舍）

### 1. 保留 Live2D 代码，只**取消挂载** ✅

**why**：删代码是不可逆的；不挂载是可逆的。`layout.tsx` 的注释写明了回退方式：
> 「想回去：把 `<Live2DLayer>{children}</Live2DLayer>` 放回这里，并恢复 xilian-figure 里的槽位注册
> （git 历史里有）。」

**为什么连挂载都不要**：没有消费方了，挂着只会**白白预载 9MB 模型 + 占着加载期空白**。

**被否决**：直接删 `lib/live2d/` —— 决策可能反复（形象是主观选择），删了要重写。

### 2. 图片走 `/api/stickers/file/:name`，**不用响应里的 `path`** ✅ ⚠️

`path` 是服务端登记值（形如 `/data/stickers/x.webp`），只有在
**"服务端真把 `data/` 当静态目录挂出来"**的部署里才取得到。

**实测本部署直接请求它 → 404。** 因此必须走专门路由（`stickerApi.fileUrl` 的注释把这条钉住了）。

> 这条是**部署相关的坑**，不是代码风格问题：换成别的部署形态时它可能"自愈"，
> 但当前形态下**用 `path` 就是坏的**。

### 3. 不预载 65 张 ✅

65 张 ≈ 8MB。只给当前这张发请求；轮换变慢时再考虑预取下一张。**注释里留了这个判据。**

### 4. 加载期**留空**，不放占位图 ✅

沿用 2026-09-25 已定的原则：
> 「占位符应当是同一个东西的粗糙版，而不是另一个东西。」
（当初是拿暖光球顶 Live2D，看起来像"被换掉了"而不是"加载好了"。）

靠**固定边长**防跳动，不靠占位图。

### 5. `prefers-reduced-motion` 下**照常轮换但不淡入** ✅

**why**：该偏好的语义是"减少动效"，不是"禁止内容变化"。轮换是**内容**，淡入才是**动效**。
把它俩分开处理，比"整个不轮换"更贴合偏好本意，也不会让这类用户永远看到同一张脸。

### 6. 与 `console-a11y-motion`（pending change）的关系 ⚠️

`console-a11y-motion` 记的是「console 17 处持续动画无 `prefers-reduced-motion` 守卫」。
本 change **只处理自己引入的这一处**（轮换淡入），**不夹带**修那 17 处，也不改它的文件。

## 对账方向确认

- [x] 与现有 spec 冲突？**是，方向为「改 doc」**：`alysia-console` §7.2 现描述 Live2D 为
  **大尺寸形象的实现**。该实现的**消费方式已被取代** → 需改写 §7.2 为「表情包轮换（Live2D 代码保留但未挂载）」，
  并把 §7.2.1 / §7.2.2（跨页持久化 / 贴图尺寸约束）标注为**保留但当前未启用**。
  ★ **不是删除** —— 它们描述的实现仍在仓库里，只是没有消费方。
- [x] 涉及 Web API？**涉及消费，不涉及契约变更**：`/api/stickers` 与 `/api/stickers/file/:name`
  是**已存在**的服务端路由（未在本 change 中新建）。契约文档 `docs/Web-API-Design.md` 若未收录，
  本次一并补。
- [x] 涉及 core / server？**不涉及**（服务端路由已存在）

## 测试计划

- [x] `npx tsc --noEmit` 干净
- [ ] 贴纸能显示（`/api/stickers/file/:name` 返回 200 且是图片）← 需运行验证
- [ ] 轮换：等满 7s 至少换一次；**不会连续两次同一张**
- [ ] 单张贴纸时不轮换（`stickers.length < 2` 分支）
- [ ] `prefers-reduced-motion: reduce` 下**仍轮换但无淡入**
- [ ] 换图不引起布局跳动（固定边长）
- [ ] 65 张**不预载**：Network 面板确认只有当前一张的请求
- [ ] 贴纸 API 失败时页面不崩（`data-sticker="loading"`，静默留空）

## 交付后的收尾

- [ ] `alysia-console` §7.2 改写 + §7.2.1/§7.2.2 标注「保留未启用」
- [ ] `alysia-console` §3 API 接入补贴纸两条路由
- [ ] `docs/Web-API-Design.md` 校对 `/api/stickers` 是否在册
- [ ] 更新 `openspec/specs/index.md` 的 `alysia-console` 行
- [ ] 归档到 `openspec/archive/2026-10-15-sticker-figure/`

## 遗留（不在本 change 范围）

- **`[表情包:名字]` 至今未渲染**（聊天里用户看到的是纯文本）—— 归 `improve-sticker-system`
- **无管理入口**（65 张图没有看/选/启停的 UI）—— 归 `improve-sticker-system`
- **hero 无差别随机**（可能抽到「どうして?!」这类情绪强图配在招呼场景）—— 归 `improve-sticker-system`

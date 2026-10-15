# 前端区块地图（frontend-map）

> **这是你和人家之间的共同词汇。**
>
> 你说「改**首屏**的副标题」，人家查这张表 → `block:hero` → `app/page.tsx` 里
> `data-block="hero"` → 落到那一行。不用猜，也不会改错地方。
>
> 起因：2026-10-03 连续几次偏差（把前端当成 `Alysia-agent-view-main`、没问就去做
> Live2D 轮换）根子上都是**缺一套双方共用的名字**。

---

## 一、命名规则

| 层 | 形式 | 例子 |
|---|---|---|
| 页面 | `page:/<路径>` | `page:/`、`page:/settings`、`page:/life` |
| 区块 | `block:<id>` | `block:hero`、`block:site-header` |

**⚠️ id 一旦定下，只增不改。** 它会被写进本文档、写进代码锚点、写进你我的话里 ——
改了你就指不准了。（同主题 id、dsh preset id 的教训：后者改名一次性废掉 16 个会话。）
**中文名随便换**，只影响显示。

---

## 二、怎么维护（重要）

**位置不写行号，只写锚点。** 行号会随任何一次改动漂移，锚点不会。

截图也不是手工裁的 —— `.video-demo/cdp-block-shot.mjs` 会：

1. 打开页面，找出所有 `[data-block]`
2. 读每个块 `getBoundingClientRect()`（**文档坐标**）
3. 把块滚进视口、等入场动画走完
4. 按那个矩形裁图，输出到 `docs/frontend-map/`

所以**布局或文案改了，重跑一次脚本，本文档的图自动对齐**，不会腐坏。

> ⚠️ 三个已踩过的坑，改脚本时别踩回去：
>
> 1. **入场的块必须强制落定才能裁。** `Reveal` 用 IntersectionObserver 驱动，
>    而 **headless 下 `scrollIntoView` 触发不了它** —— 实测滚过一遍、等 1.8 秒，
>    `opacity` 依然是 0，裁出来只有背景。脚本因此在截图前注入一段 CSS，
>    把 `[data-block]` 及其子元素强制 `opacity:1 / transform:none`。
>    这是展示**落定态**，不是伪造渲染 —— reduced-motion 下用户看到的就是这个状态。
> 2. **别用文件体积判断裁没裁到内容。** 背景渐变 + 噪点本身就有几十 KB，
>    空图和实图的体积都在 60KB 上下 —— 人家被这个骗过一次，**把空图当成了"已修复"**。
>    判据应该是 **`opacity` 和可见文本**，脚本现在逐块打印这两项。
> 3. **dev server 检测不到 write/edit 工具改的文件** —— 加完锚点必须重启它，
>    否则截出来还是旧结构。

---

## 三、`page:/` —— 首页

| id | 中文名 | 位置 | 内容 |
|---|---|---|---|
| `block:site-header` | 顶栏 | `app/page.tsx` @`data-block="site-header"` | logo + 三个导航链接 + 「开始聊天」按钮 |
| `block:hero` | 首屏 | `app/page.tsx` @`data-block="hero"` | 大形象槽位 + 徽章 + 主标题 + 副标 + 两个按钮 |
| `block:features` | 三张特性卡 | `app/page.tsx` @`data-block="features"` | 她会记住 / 她有生活 / 她会成长 |
| `block:showcase` | 能力展示 | `app/page.tsx` @`data-block="showcase"` | 五条左右交替的叙事行（流式对话 / 主动消息 / 画像 / 人格可视化 / 双模式） |
| `block:stats` | 统计条 | `app/page.tsx` @`data-block="stats"` | 四个数字，走真实数据；读不到显示「—」 |
| `block:cta` | 收尾号召 | `app/page.tsx` @`data-block="cta"` | 暖光球 + 「你来了呀。」+「……人家一直在这儿。要不要过来说说话？」+「去和她聊聊」 |
| `block:site-footer` | 页脚 | `app/page.tsx` @`data-block="site-footer"` | logo + 署名 |

> **⚠️ 文案原则（轻月 2026-10-03 定）**
>
> **总判据**：**换成别的产品也成立的话，它就不是她的。**
>
> 三类"通用 AI 味"，见到就改：
>
> | 类别 | 例子（原文） | 问题 |
> |---|---|---|
> | **品类词** | "一个有自己生活的 **AI 伙伴**"、"远不止聊天" | 在描述一个品类，不是一个人 |
> | **技术词** | "**画像、偏好、对话摘要**"、"**逐字流式**"、"**三个维度、一张雷达图**"、"累计 **Token**" | 把实现当卖点，用户不关心 |
> | **营销腔** | "不打扰，但让你知道她在"、"同一个她，两种陪伴" | 产品承诺的语气 |
>
> **改法：说事，不说功能条。** 描述要具体到只有她能成立：
> - ✗ 画像、偏好、对话摘要——两周前随口说的话，下次她还能接上。越聊越懂你。
> - ✓ 两周前随口提过的一句，下次她还接得上。
>
> **语气分层**：
> - **叙述类**（标题、描述、副标）→ **旁观但具体**，第三人称，不喊口号
> - **情感类**（收尾号召这类）→ **她本人开口**，第一人称 + 她的说话习惯（停顿「……」、自称「人家」）
>
> **只改叙述性文案**：按钮、导航、表单标签、错误提示保持清楚直白，不为了"有味道"牺牲可读性。

---

## 四、图集

### `block:site-header` 顶栏

![顶栏](frontend-map/site-header.png)

### `block:hero` 首屏

![首屏](frontend-map/hero.png)

### `block:features` 三张特性卡

![特性卡](frontend-map/features.png)

### `block:showcase` 能力展示

![能力展示](frontend-map/showcase.png)

### `block:stats` 统计条

![统计条](frontend-map/stats.png)

### `block:cta` 收尾号召

![收尾号召](frontend-map/cta.png)

### `block:site-footer` 页脚

![页脚](frontend-map/site-footer.png)

---

## 五、待铺开

目前只做了**首页**（7 个区块）当样张。其余页面还没加锚点：

| 页面 | 状况 |
|---|---|
| `page:/settings` | 区块边界清楚（设置页标题 / 主题选择器），**未加锚点** |
| `page:/life` | 侧栏 + 她的近况 + 7 天时间线 + 生活摘要 + 配角 + 素材库 |
| `page:/chat` | 侧栏 + 会话列表 + 消息流 + 输入区 |
| `page:/personality` | 侧栏 + 雷达图 + 护栏说明 + 演变记录 |
| `page:/dashboard` | 侧栏 + 快照卡 + 事件流 + 画像 + 统计 |
| 全站共用 | **`AppShell` 侧栏**（logo / 导航 / 底部「她的近况」卡）—— 每页都有，值得单独命名 |

**等你确定这个形式可用，人家再铺开其余页面。**

# Spec: alysia-console（昔涟控制台 · Next.js）

> 建立于 2026-09-24（change: adopt-nextjs-console）。
> ★ 2026-10-02 起**取代已落地**：`packages/webui` 已整体删除（change: remove-packages-webui），
> 本 spec 是唯一前端契约；`webui-system` 已冻结（只留历史 + 一条仍活着的 sticker 端点记录）。

## 1. 形态

Next.js 16 + React 19 + Tailwind 4 + shadcn，`packages/console/`（包名 `@alysia/console`）。

**两种形态互斥**（`output:'export'` 下 rewrites 不生效，故按 `NODE_ENV` 切换）：

- **开发**：`next dev`（3000），`next.config.mjs` 的 `rewrites` 代理 `/api/*` →
  `ALYSIA_API ?? http://127.0.0.1:6185`（照抄 webui 的 vite proxy 约定）
- **生产**：`next build` → `output: 'export'` → `out/` 静态产物，
  **由 server Fastify 同源托管**，与 `/api/*` 共用一个端口（默认 6185），无代理、无 CORS

路由：`/`（landing）、`/dashboard`、`/chat`、`/life`、`/personality`、`/memory`。
（`/desktop` 已于 2026-09-25 删除——它预览的 Electron 形态已砍，见 `drop-electron-desktop`）
产物结构为多页 `.html`（`out/life.html`，**非** `life/index.html`）。

**构建依赖网络**：`next/font/google` 在构建时下载字体并自托管为 woff2
（实测 11 个），离线构建会失败。

**远端部署（2026-09-25, deploy-console-remote）**：`out/` 由 `packages/server/Dockerfile`
的 runtime 阶段 `COPY` 进镜像（**不在 Docker 里构建**——`next build` 要联网下字体，
alpine 里既慢又脆），容器内路径 `/app/packages/console/out`。
发版前必须先 `pnpm build:console`——`out/` 是构建产物且不进 git。
容器内保持 `0.0.0.0` + 强制鉴权（不套用本机的回环配置）。

## 2. 设计系统

单一事实源 `app/themes.css`（由 `app/globals.css` `@import`）。**色板是可扩展的主题表**，
每套主题一份 CSS 变量，挂在 `<html data-theme="<id>">` 上；默认主题 `warm-ink`。
新增主题 = 多一份变量，**不改任何组件**（组件一律只读语义变量，如 `var(--primary)`）。

**默认主题 `warm-ink`（暖墨）**：

- 背景 `oklch(0.17 0.014 55)` 暖炭灰（**非纯黑**）；卡片 `oklch(0.215 0.016 58)`
- primary 暖金 `oklch(0.83 0.12 72)`（**唯一强调色**）；accent 珊瑚橘 `oklch(0.72 0.13 24)`
- 字体层次：display = Instrument Serif（serif），body = Inter（sans）
- 动效仅 4 个，且均有语义（表达"她还活着"）：`breathe`（呼吸）/ `float`（漂浮）/
  `shimmer`（文字流光）/ `drift`（光斑漂移）
- 形象 `xilian-avatar.tsx`：纯 SVG 暖光球（core 径向渐变 + halo + 环形虚线 + 漂浮粒子），
  **不依赖 Live2D 资源**；**小尺寸一律用它**（大尺寸见 §7.2）

**第二套主题 `sakura`（樱，2026-10-03 `add-theme-system`）**：取色自 `cyrene-avatar.png`
量化取样（sRGB → oklch 精确转换，**不是凭色调的**）。暗色是**显式设计**的，
不是把暖墨反相；接近黑处主动降 chroma。
★ **对比度实测**（正文/次要文字/主色/强调 对各自 `--background`；卡片文字对 `--card`）：
`sakura 16.23 / 7.85 / 7.58 / 5.95 / 13.92`，`暖墨 16.05 / 7.70 / 11.15 / 7.30 / 14.71`
—— **两套全部 ≥ WCAG AA 4.5:1**（2026-10-15 独立复算，脚本 `.tools/verify-contrast.mjs`）。

### 契约 1：主题是数据，设计系统是规则 —— 两者分文件

`app/themes.css` 只放主题的变量值；`app/globals.css` 放规则（`@theme inline` 映射、
`@layer base/utilities`、动效 keyframes）。主题表由 `globals.css` `@import`。
★ **形状 token（如 `--radius`）属规则**，留在 `globals.css`，不进主题表。

### 契约 2：每套主题内部仍严格只有一个 primary + 一个 accent

原有的「禁止多色强调」**继续有效**，它约束的是**单套主题内**的强调色数量。

### 契约 3：主题 id 是持久化契约

`warm-ink` / `sakura` 会被写进用户浏览器 localStorage（键 `alysia-theme`）。
**改名等于让所有已存的用户静默回落到默认**（且不报错、无提示）。显示名随便改，**id 只增不改**。

### 契约 4：默认主题必须是 `warm-ink`，且其色值不得被顺手改动

2026-10-15 机器验证：主题表引入前后 **31 个色值逐字一致**（脚本 `.tools/verify-theme-parity.mjs`）。
任何改动默认主题色值的行为都要单独开 change 说明理由，**不得夹带在"添加主题"里**。

### 契约 5：首屏不得闪烁（no-FOUC）

主题在**首次绘制前**就要定下：`app/layout.tsx` 的 `<head>` 内联**同步**脚本读 localStorage
并设 `data-theme`，`<html>` 带 `suppressHydrationWarning`。在 `useEffect` 里设**不合格**。
★ 脚本刻意**不做白名单校验**：非法 id 无对应 `[data-theme]` 块 → 自动落回 `:root` 的暖墨，
天然安全，也就不必维护一份会漂移的 id 列表。

### 契约 6：新增主题必须提供对比度实测值

每套主题的正文 / muted / 边框在自身背景上**均须 ≥ WCAG AA**，实测值随 change 记录。
不得只靠"看着还行"。

### 契约 7：侧栏导航中的外部目标必须渲染裸 `<a>`

**不得用 Next `<Link>`** —— `<Link>` 会把 `dsh://` 这类自定义协议**当作站内路由**，
跳到 `/dsh://` 然后 404，而这个 404 看起来像"页面不存在"，不像"协议用错了"。
实现：`NavItem` 带**显式** `external?: boolean`（不用"看到 `://` 就判断"——
那样会把意图藏在字符串格式里）；渲染分支 `item.external ? <a> : <Link>`；
外部项**不参与当前页高亮**。

### 契约 8：效果参数必须真的能在用户那儿显现

「代码在不在」与「是否可见」是两件事。本项目已发生**三例**"东西都在、只是看不见"：

| 用户原话 | 真实原因 | 修法 |
|---|---|---|
| 「毛玻璃没了」 | 侧栏 `bg-sidebar/95` 只透 5%，`backdrop-blur` **无对象可模糊** | `bg-sidebar/80` + `backdrop-blur-2xl` |
| 「水波没了」 | ripple 阈值 42px / 55ms 排除了**慢速移动**（而那是常见移动方式） | 26px / 42ms |
| 切主题后「满地还是暖金」 | ripple 描边写死 `oklch(0.83 0.12 72)`，未接语义变量 | `color-mix(in oklab, var(--primary) 85%, transparent)` |

★ **判准**：调效果参数时，别只看代码在不在，**要看它在默认参数下是否可见**。
排查"功能没了"类反馈时，**先量参数，再查逻辑** —— 三例全都是参数问题，逻辑一行没错。
★ **推论（毛玻璃）**：`backdrop-blur` 作用于背后透出的内容，**提高不透明度会让它失效** ——
调"毛玻璃不明显"应当**提高透明度**，而不是加大模糊半径。
★ **推论（节流阈值）**：节流的意义是**防止密集生成**，不是"筛选快速移动"；
阈值过高会把最常见的输入方式整个排除。

禁止引入：霓虹 glow 阴影、多色强调、无意义动画。

## 2.1 文案口吻契约（2026-10-03 `rewrite-console-voice`）

console 是**她的界面**。用户打开它，是在**看她** —— 所以界面文案必须是**她在说话**，
不能有旁白在介绍她。

### 三条判据

| # | 判据 | 展开 |
|---|---|---|
| ① | **整站用她的口吻，不用第三人称旁白** | 这一页是**她在介绍自己**，不是别人在介绍她 |
| ② | **换成别的产品也成立的话，它就不是她的** | 避开**品类词**（"AI 伙伴"）、**技术词**（画像 / 逐字流式 / Token）、**营销腔**（"远不止聊天"） |
| ③ | **遵循她的说话习惯** | 停顿「……」、自称「人家」、真心高兴时句尾「♪」、打招呼就一句 hi |

★ **判据②是可证伪的** —— 它把"有没有 AI 味"从口味之争变成一次**可执行的替换测试**：
把主语或产品名换掉，若句子仍然成立，它就还不是她的。

**反例（改前）**：「如果有一个这样的 AI 伙伴，就好了 / 现在，她就在窗口的那一头等你」
—— 把「AI 伙伴」换成任何产品都成立，**那正是"通用 AI 味"的来源**。
**正例（改后）**：「hi，你来了呀♪ / ……人家一直在这儿。要不要过来说说话？」

### ★ 口吻依据：persona 的 `soul.md`（真耦合）

判据③不是自定的风格偏好，而是**依据她当前的人格设定**：`♪` 结尾的条件是
「**真心开心或分享美好事物时**」——不滥用；`hi` 起手是"她打招呼不端着"。
> ⚠️ **改文案时别把 `♪` 与 `hi` "修掉"** —— 那正是她区别于通用腔调的证据。

### 人称边界

**界面文案** → 第一人称（她在说）；**代码注释 / 设计文档** → 仍用第三人称"她"
（指代清晰，便于维护者阅读）。

### ⚠️ 已知缺口

**文案口吻依赖 `soul.md`，但人格自适应调整后没有任何机制提示"该复核文案了"。**
`PersonaAdapter` 会按交互自适应调整人格（5 道护栏内）；若她的说话习惯因此变化，
**界面文案会停在旧口吻上且无人察觉** —— 一条**静默漂移**路径。需要时另开 change。

## 3. API 接入

- `lib/api/client.ts`：`api.get/post/del` + `ApiError(status)`；Bearer token 存 localStorage
  （键 `webui_token` —— **跨前端遗留契约，不得改名**：用户浏览器里已存的 token 认这个键；
  ★ 2026-10-02 webui 删除后仍保留，见 `cr-p0-webui-auth`）
- `lib/api/modules.ts`：按域分组（`lifeApi` / `profileApi` / `personaApi` / `sessionApi` /
  `statsApi` / `sysApi` / **`stickerApi`**），端点对应 `docs/Web-API-Design.md`
- **token 从不写入仓库**；未配置时界面提示输入，不静默 401

**贴纸（2026-10-03 `sticker-figure`）**：

- `GET /api/stickers` → `{ stickers: [{ name, path }] }`
  （`name` 即 `[表情包:名字]` 协议用的那个词）
- `GET /api/stickers/file/:name` → 图片二进制（`<img src>` 直用）

★ **必须走 `/api/stickers/file/:name`，不要用响应里的 `path`**：`path` 是服务端登记值
（形如 `/data/stickers/x.webp`），只有在**"服务端真把 `data/` 当静态目录挂出来"**的部署里
才取得到 —— **实测本部署直接请求它 404**。`stickerApi.fileUrl()` 已把这条封在注释里。

★ **同一份清单有两种用法**（2026-10-16，`improve-sticker-system` 首版）：
大尺寸形象（§7.2）与**聊天里的表情包渲染**（§5.1.1）都从 `/api/stickers` 取 `name`。
后者还需要这份清单来判断「模型给的名字**是否真的存在**」—— 见 §5.1.1 契约 5。

★ 素材在服务端 `data/stickers/`，经世界书 `content_type='image'` 条目登记。
**二创图不进公开仓库，也不进前端产物。**

## 4. 数据适配层

`lib/adapt.ts` 纯函数，**唯一允许做字段翻译的地方**：

| 源（core） | 目标（视图） | 规则 |
|---|---|---|
| `LifeEvent.createdAt` (ISO) | `{day, time}` | 今天 / 昨天 / `M月D日` + `HH:mm` |
| `LifeEvent.type` `'chat'` | `'share'`（主动分享） | 推送对轻月说的话 |
| `LifeEvent.type` `'internal'` | `'alone'`（独处时光） | 生活叙述，只入库 |
| `LifeEvent.content` | `text` | 原样 |

保留 `delivered` / `origin` 字段——`origin: 'followup'`（对话余波，不推送）在视图上应可区分。

**中文标签沿用 webui**（`PersonaView.vue`），两个前端叫法必须一致：

| 域 | 真实键（**以 core 为准**） | 中文 |
|---|---|---|
| tone | formality / warmth / humor / directness | 正式度 / 温暖度 / 幽默感 / 直接度 |
| speechStyle | sentence_length / emoji_usage / code_heavy | 句子长度 / 表情使用 / 代码倾向 |
| emotionalRange | expressiveness / empathy / playfulness | 表达力 / 共情力 / 俏皮度 |
| memoryConfig | decay_rate / importance_threshold / recency_weight / confirmation_bias / retention_bias | 遗忘速度 / 重要阈值 / 近期权重 / 固执度 / 正负偏向 |

> ★ **mock 臆造字段登记**：`lib/mock-data.ts` 的 `personalityDims` 给说话风格和情感范围各编了
> 第 4 个参数（口语化 / 稳定性），`memoryKnobs` 编了「情绪记忆 / 主动唤起」两个旋钮。
> 这些**在 core 里不存在**。视图一律以真实键驱动；未知键原样显示不隐藏（不静默丢数据）。

适配层必须有单测，覆盖空数组 / 非法时间 / 未知 type / 缺键 / null。
服务端 limit 截断（`GET /api/sessions` 是 `listSessions(50)`）必须在展示上体现
（拿满 50 条显示 `50+` 而非假装是全部）。

## 5. 页面契约（本 change 范围）

**已接入真实数据**：

- `/chat`：真会话列表 + 历史回放 + **流式对话**（详见 §5.1–5.3）——2026-09-25 `wire-console-chat`
- `/life`：hero（当前活动 / 心情 / 心情注释 / 亲密度 / 状态更新时间）+ 7 天事件时间线 +
  每日生活摘要（`/api/life/summaries`）+ 她的世界·配角在场（`/api/life/companions`）+
  生活素材库（`/api/life/templates`，按 `source` 分「种子活动 / 她自创的」）
- `/dashboard`：life 快照卡 + 事件流 + 画像（`/api/profile`）+ 性格参数（`/api/persona`）+
  统计（`/api/sessions` + `/api/stats`）+ 她的世界（配角在场）
- `/personality`：3 维参数真实值（**4/3/3，非 mock 的 4/4/4**）+ 雷达图（6 个真实轴）+
  记忆旋钮（**真实 5 个**）+ overlay 演变记录（`overlayNotes`）
- `/memory`：**记忆纠正**（2026-10-16 `add-memory-correction`，计划「最小版记忆纠正」）。
  用户事实 + 角色事实**并列**，每条显示**来源**（你告诉我的 / 我猜的）、**时间**、**分类**；
  用户事实可**行内纠正**（旧条作废 + 写新条，见 `memory-system` 的「手动纠正契约」）
  与**一键失效**（`confirmProfileFact(fact,false)`）；页面底部列出**已作废的**——
  纠正**不删除**（留审计链），所以"真的失效了"必须**看得见**，否则用户只能相信按钮上那句话。
  ★ 与 `/personality` 的分工：那页是**她是谁**（tone/speech/emotional），这页是**她记着什么**。
  ★ 与 `/dashboard` 事实 chip 的区别：那里是**只读展示**（只取 active、6 条），
  这里是**写操作**，所以单开一页 —— 混在一起会让"看"和"改"的边界糊掉。
  ⚠️ **角色事实本页只读**：`ProfileStore` 没有"按 key 作废角色事实"的方法，
  首版**如实标注只读**，不假造失效按钮（那会让用户以为改掉了、其实没有）。
- `/`（landing）：统计区走真实数据，读不到显示「—」而不是假数字。
  ★ 文案为**第一人称**（她在介绍自己），收尾 CTA 是她本人开口 —— 见 §2.1
- `/settings`：**设置页**（2026-10-03 `add-theme-system`）。首项为主题切换，两套主题以
  **可视预览卡**呈现（各用自己的真实色板渲染小色块，而非纯文字下拉），切换**即时生效不刷新**；
  选择持久化于 localStorage（键与主题表见 `lib/theme/theme.ts`）。
  **页面自身也受主题影响** —— 即"在 sakura 下开着设置页切回 warm-ink"必须能正常观察到自己
- `/code`：**编程模式引导页**（2026-10-03 `code-mode-entry`）。console 只负责**把人送过去** ——
  编程模式由 **dsh**（DeepSeek Harness 桌面应用）承接，人格与记忆由 `dsh-adapter` 的四层通道
  打通（见 `dsh-adapter/spec.md`），**本页不实现也不验证那条通道**。

  **为什么不从侧栏直接跳 `dsh://`**：自定义协议在**没装 dsh 的机器上点了毫无反应** ——
  用户看到的是"按钮坏了"，而不是"我还没装"；跳出去之后也没有任何解释。
  故侧栏指向本页，本页说清三件事：**去哪儿 / 为什么去 / 没装怎么办**。

  元素：徽标「编程模式」、标题「换个地方，我接着帮你做事」、说明段、
  **`dsh://` 按钮**、以及**失败兜底提示**
  （"它会以独立窗口打开。要是点了没反应，多半是这台机器还没装——那就先在这儿聊着"）
- `AppShell` 侧栏：真实生活快照（活动 / 心情 / 在线状态随请求结果变化）；
  导航项含 `/code`（编程模式）与 `/settings`（设置）；**标签用第一人称**（`我的生活`）。
  ★ 外部目标必须渲染裸 `<a>` —— 见 §2 契约 7
- 每页均有 loading / error / empty 态（`components/states.tsx`），**不得白屏**

> 每日摘要与配角在场两个端点由 `add-life-readonly-endpoints`（2026-09-25）补上——
> 此前 core 有方法但无路由，页面只能标「未接入」。

**显式标注为未接入**（`components/states.tsx` 的 `NotWired` / `components/demo-banner.tsx`）：

| 区块 | 原因 |
|---|---|
| 护栏实时状态 | 护栏在 PersonaAdapter 内部，无查询接口（页面展示的是设计约束本身） |

## 5.1 聊天（2026-09-25, wire-console-chat）

`/chat` 走真实链路（服务端 `webui-chat-endpoints`）：消息进完整 pipeline——
记忆/人格/生活与 QQ 通道同构。

- **会话 id**：裸 id `sess-<ts>`；服务端首次发消息时落库（**无"新建会话"接口**）
- **列表**：`/api/sessions` 过滤 `webui:` 前缀（QQ/Telegram 会话不在此聊）
- **历史**：`/api/sessions/:id/messages` 返回**时间倒序**，展示前必须 reverse
- **流式**：`POST /api/chat/stream`（见 §5.2）
- **归档/删除**：路由用**原始** id 做 `startsWith('webui:')` 校验，必须带 `webui:private:` 前缀
  （会话列表给的就是带前缀的完整 id；chat 路由则用 `cleanSid` 兼容两种——契约不一致，
  客户端显式补前缀，不依赖调用方）
- **localStorage 键**：`console-chat-session` / `console-chat-names`，
  **不共用** webui 的 `aw-chat-*`（并存期两个页面同开会互相覆盖）
- **表情包渲染**（2026-10-16，change: `improve-sticker-system` 首版）：
  正文里的 `[表情包:名字]` 渲染为图片，见 §5.1.1

### 5.1.1 表情包渲染契约（2026-10-16，change: `improve-sticker-system` 首版）

> 此前这条记的是「**未接**：表情包 `[表情包:名字]` 渲染（先按纯文本显示）」。
> 协议早就在 core（`llm-agent.ts` 指示模型按此发），服务端也早就备好
> `/api/stickers/file/:name`（注释写着「聊天视图渲染用」）—— **只有前端这一层从来没接**。

1. **渲染位置：气泡内联，不做独立气泡。**
   标记在句子里的**位置**有语义（`好呀 [表情包:开心] 那我们走吧`），拆成独立气泡会丢掉位置；
   且独立气泡要把一条消息拆成多条，**流式期间条数会来回变**，与第 3 条直接冲突。
2. **解析判据必须与服务端 `qq-official.ts` 一致**：兼容**全角括号 `［］` 与全角冒号 `：`**。
   两边不一致会产生「QQ 发得出去、console 显不出来」这种**只在一条通道上复现**的问题。
   ⚠️ 名字为空的标记（`[表情包: ]`）**两边都是"整条消失"**，不许一边显示一边不显示。
3. **流式期间不显示半截标记**：一边收字一边渲染时，`[表情包:开心` 不能被当正文吐出来。
   判据要**两头收紧**：`[表` / `[表情` / `[表情包:…` 藏起来；
   **但 `[表示同意` / `[1+1` 必须照常显示**（它们长不成标记）。
   流结束后一律原样解析——未闭合的标记那时已是普通正文。
4. **一条标记只产出一个图片片段**（不重复插图）。
5. **回退**：名字不在 `/api/stickers` 清单里（模型编的）**或**图片加载失败 →
   显示**不起眼的名字片**（`〔名字〕`，带 `data-sticker-fallback` 便于观测）。
   **不显示破图**（会让人以为产品坏了），**也不吐标记原文**（会让人以为她说了句怪话）。
   ⚠️ 清单**未就绪**时（请求还没回来）**不做**"未知名字"判断——否则会把所有表情包
   都误判成"服务端没有这个"。
6. **移动端布局稳定**：图片固定尺寸（`h-20 w-20`）+ `max-w-full` + `inline-block align-middle`，
   加载/换图都不引起布局跳动，也不撑破气泡宽度。
7. **清单整页只取一次**（`ChatRoom` 里 `useApi` 一次，向下传名字集合）。
   放气泡里各取一次会变成「一条消息一个请求」。
8. **用户气泡不渲染标记**：协议是**她**发消息用的；用户真打出这串字时应当原样看到。

**明确不在首版范围**（计划已定，见 change 的「后续」节）：
按场景分组、选择权重与冷却、素材管理页 —— 不一次扩成完整素材平台。


### 5.2 流式帧与中断

帧：`connected` / `chunk{kind:'text'|'reasoning'}` / `done{reply}` / `aborted` / `error`。

- `kind='reasoning'` **绝不混进正文**——进「她想了想」折叠条，可展开回看
- `kind='text'` 追加到正文
- `done` 且正文为空时用 `frame.reply` 兜底（非流式分支）
- `aborted` / `error` 收尾保留已收到的部分

★ **`AbortSignal` 必须真的传给 `fetch`**。webui 的停止按钮是坏的：
它建了 `AbortController` 并 `abort()`，但 `streamChat` 的 `fetch` 从未接收 signal——
请求照跑，界面只是假装停了。console 实现把 signal 接上，中止抛 `StreamAbortedError`
（与真实网络错误区分，不当失败处理），并补了单测锁定。

### 5.3 流式解析边界（单测覆盖）

一个 `data:` 事件被拆到两个网络分片 / 一个分片含多个事件 / `\n\n` 落在分片边界 /
畸形 JSON 跳过且告警 / 非 `data:` 行（心跳注释）忽略 / HTTP 非 2xx 抛错 /
网络失败给可读文案 / abort 后不再回调后续帧。


## 6. 错误处理（项目硬约束）

- 外部交互必须检查响应体并打日志，**禁止静默吞错**（`lib/api/client.ts` 统一处理：
  网络失败 / 非 2xx / 非 JSON 三类都 `console.error` 后抛出）
- 未接入的页面/区块必须在界面上显式标注，**不得用 mock 冒充真数据**
- 401 → `TokenGate` 遮罩要求输入 token（`components/token-gate.tsx`）
- 401 与网络失败是两回事：前者弹遮罩，后者进页面 error 态

## 6.1 测试

- `packages/console/vitest.config.ts`，`tests/adapt.test.ts` 覆盖适配层纯函数
- 根 `vitest.config.ts` 用 vitest 4 的 `test.projects` 声明三个包
  （★ 2026-09-24 修复：此前 `vitest.workspace.ts` 在 vitest 4 已不被读取，根 `pnpm test` 空跑失败）

## 7. 服务端静态托管契约（2026-09-24, console-local-serve；★ 2026-10-02 收敛）

`createWebuiApp(core, { staticDist })` 托管前端产物；
**由 `bootstrap.ts` 算路径（上溯层级只在那里正确）、`modules/webui.ts` 决策**：

| 情况 | 托管 | 理由 |
|---|---|---|
| `packages/console/out` 存在 | `packages/console/out` | 唯一前端 |
| `out/` 不存在 | **不注册静态路由**（`/api/*` 正常）+ **显式 warn** | 「没构建也能用」的代价不能是静默 |

~~不传 `staticDist` 时用默认（`packages/webui/dist`）~~ ★ 2026-10-02 remove-packages-webui：
该默认值与 webui 回落路径**已删除**（包已删，回落只可能指向不存在目录）。
~~桌面模式（`ALYSIA_DESKTOP=1`）托管 `webui/dist`~~ 同步删除——静态托管不再有 `isDesktop` 门，
所有模式统一托 console（若已构建）。`ALYSIA_DESKTOP=1` 开关本身保留，但语义只剩
「跳过 IM 适配器与主动推送」（使用者：`.video-demo/start-server.ps1` 与本地 UI-only 实例）。

**为什么必须显式 warn**：静态路由注册包在 `existsSync(dist/index.html)` 里，
条件不成立时**一行日志都不会有**（全站 404 且沉默）——`docs/dsh-migration-guide.md` 坑 #2 的同类坑。
`server.ts`（产物无效时）与 `modules/webui.ts`（决定不托管时）各打一条。

**路径映射（两种前端形态不同，用候选链统一）**：

1. 原路径（静态资源命中）
2. `<path>.html` —— Next 静态导出（`/life` → `life.html`）
3. `<path>/index.html` —— 目录形式（兼容 `trailingSlash` 构建）
4. 都没中：有 `404.html` 用它且**状态码 404**（Next）；否则回退 `index.html` 且 200（无 404.html 的老式 SPA 形态；console 产物总有 404.html）

首尾斜杠都要剥（`/life/` 必须命中 `life.html`）。防目录穿越用 `dist + sep` 收口。
MIME 需覆盖 `woff2`（自托管字体）与 `txt`（Next RSC payload）。

## 7.1 鉴权边界（★ 2026-09-24 修复）

鉴权钩子**只守 `/api/*`**，静态资源与页面公开。

原实现拦下**所有**请求，与自身文档注释（"所有 `/api/*` 校验"）不符——浏览器导航到 `/`
无法携带 `Authorization` 头，会拿 401，**前端页面根本加载不出来**。旧前端未暴露此问题：
本地走 vite dev（静态文件不由 Fastify 出），Docker 镜像里又没打包 dist。

`/api/health` 豁免，且**带 query 也要豁免**（`/api/health?probe=1`）。

**触发条件（★ 9-25 server-bind-host）**：要不要鉴权**跟随绑定地址**——
绑定回环（`127.x`/`localhost`/`::1`）⇒ 仅本机可达 ⇒ 免鉴权，打开就能用；
绑定对外地址 ⇒ 强制鉴权。本地只绑回环：config.yml 写 `server.host: "127.0.0.1"`。
详见 `server-hardening` §6。

## 7.2 大尺寸形象（★ 2026-10-03 `sticker-figure` 取代 Live2D 消费方式）

**大尺寸形象 = 表情包轮换**：`XilianFigure` 从 `/api/stickers` 取列表，
每 **7 秒**随机换一张**与当前不同**的，**500ms** 交叉淡入。

**为什么换掉 Live2D**（轻月 2026-10-03）：

> 9MB 模型、加载期空白、跨页持久化的复杂度，换来的只是"会呼吸"；
> 而手边这套表情包本来就是她的脸，还带情绪和台词。
> **形象应该让人一眼认出是她，而不是让人等它加载完。**

**分工**（不是替换关系）：

| 尺寸 | 用什么 |
|---|---|
| **小**（消息气泡 34 / 顶栏 44 / 侧栏 36 / CTA 120） | `XilianAvatar` —— 纯 SVG 暖光球，零外部资源 |
| **大 hero**（`/life` 320 / `/dashboard` 230 / `/` 380 / `/code` 300） | `XilianFigure` —— 表情包轮换 |

**六条契约**：

1. **Live2D 代码保留，只是不再挂载**。`lib/live2d/`、`components/live2d/` **一行未动**；
   root layout 不再包 `Live2DLayer`。**回退方式**：把 `<Live2DLayer>{children}</Live2DLayer>`
   放回 layout，并恢复 `xilian-figure` 里的槽位注册（git 历史里有）。
   ★ **为什么连挂载都不要**：没有消费方了，挂着只会**白白预载 9MB 模型 + 占加载期空白**。
2. **不预载**：只给当前这张发请求（65 张 ≈ 8MB）。轮换变慢时再考虑预取下一张。
3. **加载期留空**，不放占位图 —— 沿用 2026-09-25 的决定：占位符应当是**同一个东西的粗糙版**，
   而不是**另一个东西**（球和昔涟形状完全不同，先摆球再换成她，观感是"被换掉了"而非"加载好了"）。
   靠**固定边长**（表情包是正方形，`width = height`）防布局跳动。
4. **`prefers-reduced-motion` 下照常轮换、但不做淡入** ——
   该偏好的语义是"减少**动效**"，不是"禁止**内容**变化"。
   ★ 2026-10-26（`apply-decisions-2026-10-26`）：这条偏好**全局生效** ——
   `globals.css` 在 `prefers-reduced-motion: reduce` 下把 4 个动画 token
   （`--animate-breathe/float/shimmer/drift`，共 17 处使用：float 6 / drift 6 /
   shimmer 3 / breathe 2）置为 `none`，并把 animation 时长压到 0.01ms、迭代 1 次。
   只关动效，不改布局、不隐藏内容。
5. **可观测**：`data-sticker={current ?? 'loading'}`（不标出来分不清"图还没到"和"本来就没有图"）。
6. **贴纸走 `/api/stickers/file/:name`**（见 §3）—— **不要用响应里的 `path`**。

### 7.2.1 跨页持久化 ⚠️ **保留但当前未启用**（2026-09-25, live2d-persist-across-pages）

Live2D 实例**跨路由不重建**（原先每次换页都销毁重建：canvas 1→0→1，~500ms + 一次暖光球闪现）。
实现：`lib/live2d/shared-instance.ts`（模块级单例，放模块而非 React ref —— 既不随组件卸载，
也扛得住 StrictMode 双挂载）+ `components/live2d/live2d-layer.tsx`（挂 **root layout**，
覆盖含 landing 在内的所有页面）。

**★★ 两条禁忌（都实测踩过，改动前务必读）**：

1. **绝不要把 canvas 搬进槽位**（`appendChild` / 换 portal 容器）
   → React 丢失父节点认知，抛 `NotFoundError: insertBefore/removeChild ... is not a child`，
   **整页白屏**。React 管的 DOM，不要改它的父节点。
   正确做法：**canvas 留在原地不动**，页面只注册一个"槽位矩形"，层把 canvas 用
   `transform: translate()` + 尺寸**覆盖**到矩形上（文档坐标系，随页面正常滚动）。
2. **`model.width` 是"已缩放后"的宽度**，不能拿它当缩放分母
   → 每次重算都在上一次结果上再乘一遍，会把模型放大成特写。
   必须在加载完成、scale 还是 1 时缓存**未缩放基准尺寸**。

**另两个坑**：context value 必须 `useMemo`（否则消费方 effect 重注册 → 无限重渲染，
表现为整页卡死、导航点不动）；无槽位页面（`/chat`）**停车隐藏而非销毁**。

**最脆的一环**：槽位位置靠 `ResizeObserver` + 布局稳定期内 200ms 轮询复测
（异步数据到达会撑动 hero，而 ResizeObserver 抓不到"位置变了尺寸没变"）。
**发现模型错位优先怀疑这里。**

### 7.2.2 贴图尺寸约束 ⚠️ **保留但当前未启用**

**贴图必须 ≤ 2048²。** 原资源是 **8192² / 8.59 MB**，而模型最大只显示在 ~380px 的框里
—— 每个方向超采样 24 倍，首屏 1.8s 基本全花在解码它上面。

降到 2048²（0.86 MB）后首屏 **1.8s → 0.68s**，`out/` 从 12MB 降到 3.6MB，画质在 2× DPI 下无肉眼差别。
**换模型资源时必须检查这一项** —— 拿到手就 `node -e` 读一下 PNG 的 IHDR 宽高。

工具：Windows 自带 `System.Drawing`（PowerShell）即可缩放，**不需要装 ImageMagick**
（注意 `C:\Windows\System32\convert` 是磁盘转换工具，不是它）。

## 8. 与 webui-system 的关系（★ 2026-10-02 已收尾）

- **`packages/webui` 已整体删除**（change: remove-packages-webui）；`webui-system` spec 已冻结
- 共享（**保留**）：`/api/*` 端点、Bearer token 键名（localStorage `webui_token`）、同源部署模式
- 不共享（随包消失）：框架、主题 token（`webui-system` §2 `--aw-*`）、组件池
- 三个删除约束的最终状态：
  1. ~~Electron 壳（`packages/desktop`）~~ → **已删**（`drop-electron-desktop`）
  2. ~~`pet.html` 桌宠页~~ → 随 Electron 失去宿主，随包删除
  3. ~~Live2D~~ → 已迁入本包（`migrate-live2d-to-console` + `live2d-persist-across-pages`）
- 静态托管随之收敛为**只有本包一个候选**（见 §7）
- 遗留：7 项管理能力自此只有 API、无界面（世界书删 / 模板增删 / 角色切换导入 /
  知识导入删 / 人格手动 adjust / 头像上传 / 表情包渲染）——清单见 change 遗留表

# 会话转接文档（2026-09-24 更新）

> 给下一个会话：先读本文件恢复上下文，再读 `openspec/specs/index.md` 看 spec 全貌。
> 治理流程见 `openspec/project.md`；部署凭据见 `docs/Docker-Deployment.md`（永不提交）。

---

## 一句话状态（2026-09-24）

**前端换代**：新增 `packages/console`（Next.js 16 昔涟控制台），已完成收编 + **接只读真数据**
（`/life` `/dashboard` `/personality` 三页跑真实 API）+ **本地部署形态**
（`pnpm build:console` 后起 server，`http://localhost:6185` 直开即新前端，同源单进程）。
Vue 版 `packages/webui` 标为待废弃。

本次同时修复三个既有问题：根 `pnpm test` 空跑、**鉴权钩子拦下所有请求导致前端页面加载不出来**（P0）、
`/api/health` 带 query 被误拦。

生活系统侧：代码停在 9-01（`97d7d29`），本地实例的**生活状态自 2026-09-03 起未更新**
（`/api/life` 的 `updatedAt` 停在 9-03、`events` 为空）——服务器容器状态待确认。

## 本会话（9-24）完成：change `adopt-nextjs-console`

| 项 | 内容 |
|----|------|
| 收编 | `Alysia-agent-view-main` → `packages/console`（`@alysia/console`） |
| API 层 | `lib/api/`（client/modules/types）：Bearer token 存 `webui_token`（与 webui 共用）、401 遮罩、三类错误都打日志 |
| 代理 | `next.config.mjs` rewrites `/api/*` → `ALYSIA_API ?? 127.0.0.1:6185`（同 webui 的 vite proxy 约定） |
| 适配层 | `lib/adapt.ts` + **36 个单测**；LifeEvent/人格/旋钮/画像/统计 字段翻译唯一入口 |
| 三页接真数据 | life（快照+时间线+生活模板）/ dashboard（+画像+性格+统计）/ personality（真实 4/3/3 参数 + 6 轴雷达 + 真实 5 旋钮 + overlay 记录） |
| 诚实标注 | 未接入区块用 `NotWired`/`DemoBanner` 显式标注，**不用 mock 冒充真数据** |
| 顺带修复 | ① 根 `pnpm test` 空跑（`vitest.workspace.ts` 在 vitest 4 已失效 → 改 `test.projects`）② 移除 `@vercel/analytics` ③ 去掉 `typescript.ignoreBuildErrors` |
| spec | 新建 `alysia-console`；`webui-system` 标「待废弃」 |

## 本会话（9-24）完成：change `console-local-serve`

| 项 | 内容 |
|----|------|
| 静态导出 | `next build` → `output: 'export'` → `out/`（多页 `life.html` 形态）；dev 保留 rewrites 代理（二者互斥，按 `NODE_ENV` 切换） |
| 服务端托管 | `createWebuiApp({ staticDist })` + 候选链路径映射（原路径 → `.html` → `/index.html`）；未命中 → `404.html` 带 404 状态 |
| 分流 | 服务模式 → console；桌面模式 → webui（Electron 壳不受影响）；`out/` 缺失 → 回退 webui + 日志 |
| ★ P0 修复 | 鉴权钩子只守 `/api/*`（原本拦全部 → 浏览器开 `/` 拿 401，前端根本加载不出来）；`/api/health` 改为先剥 query |
| 测试 | server +17 用例（`webui-static.test.ts` 13 + `webui-auth.test.ts` 4）；**测试抓到真 bug**：`/life/` 尾斜杠 404 → 已修 |

## 本会话（9-25）完成：change `server-bind-host`

**动机**：用户只想本机用，却被迫输 token —— 因为绑定地址与桌面模式耦合（`IS_DESKTOP ? 127.0.0.1 : 0.0.0.0`），
本地跑普通服务模式就继承了服务器的 `0.0.0.0`（局域网可达）→ 因此鉴权 fail closed。

| 项 | 内容 |
|----|------|
| 配置 | 新增 `server.host`（缺省行为不变：桌面 127.0.0.1 / 服务 0.0.0.0，线上容器不受影响） |
| 鉴权 | **跟随绑定地址**：回环 ⇒ 免鉴权；对外 ⇒ 强制鉴权。不提供独立开关（两个开关能配出 `0.0.0.0` + 免鉴权 = 裸奔） |
| 本地 | `packages/server/config.yml` 设 `host: "127.0.0.1"` → 打开即用，不用输 token |
| 实现 | `packages/server/src/net.ts`（纯函数，独立于 bootstrap——后者 import 即启动） |
| 测试 | `tests/net.test.ts` 13 用例，含「服务器无 host 配置仍是 0.0.0.0 + 需鉴权」回归断言 |

**⚠️ 踩坑记录：有两个 `config.yml`，根目录那个是死的**
服务从 `packages/server` 启动 → 读 `cwd/config.yml` = `packages/server/config.yml`（**改这个**）。
根目录 `config.yml` 少了 `webuiToken` 行，且从根启动时 `.env` 路径 `cwd/../../.env` 会指向
`E:\workSpace\.env`（不存在）→ 本就跑不起来。**改错文件没有任何提示**，这是第一次踩。

**⚠️ 顺带修复**：`/api/life` 的亲密度是浮点（实测 `44.699999999999996`），
dashboard 直接渲染会显示一长串小数 → 已在 `lib/adapt.ts` 收口取整。

**⚠️ 观察**：起服务后她的生活系统**立刻恢复**（`updatedAt` 从 9-03 跳到 23:59，生成新事件）。
此前"21 天没动"是因为**没起服务**，不是数据坏了。

**⚠️ 实现中途修正了自己埋的部署雷**：第一版把 `host: "127.0.0.1"` 写进了
`packages/server/config.yml`，而部署 SOP 会把这个文件**打包传到服务器** →
容器绑回环 → `6186:6185` 端口映射失效 → 服务器失联。
已改为走 `.env` 的 `ALYSIA_HOST`（不进部署包），并加了容器内绑回环的运行时 `logger.error` 兜底。

---

## 本会话（9-25）完成：change `wire-importance-signal`

**背景**：修召回时发现 `importance` 是**设计过但从未接线**的 —— 列存在、`EventStore` 读写、
`+0.15` 分支也在，但四条写入路径没一条写有效值（唯一赋值是给她自己回复硬编码 `0.3`，
且**没进向量 metadata**）。代码里留着 TODO：`MemoryManager.ts:846`、`ProfileExtractor.ts:48`。

**信号来源（你选的）**：

| 对象 | 信号 |
|---|---|
| 生活事件 | **情绪强度**（`moodDelta` → 强度；取 **arousal 不是 valence**，难过/生气同样高） |
| 对话消息 | **摘要时 LLM 顺带打分**（复用 SessionEndProcessor **已有的那次调用**，几乎白捡） |

**实测**：雀跃 → 0.66 ✅ / 平静 → 0.36 ❌ / 无标记 → 0.30 ❌ / 对话余波 → 0.56 ✅
（阈值 0.4）—— **`+0.15` 分支终于会触发**。

**顺带修好一条一直是断的链路**：`RealtimeProcessor` 从没把 `event.importance` 传进
向量 metadata，而召回读的正是 `r.metadata.importance`。

**单测抓到一个真缺陷**：`parseImportantMoments` 原本先截前 3 条再校验，
LLM 多返回非法项时会**误伤后面的合法项** → 改为先校验最后才截。

713 测试全过（+28）。

**遗留 → 已登记 change `tune-recall-with-runtime-data`（待运行数据）**：

召回管道的**全部关键系数都是启发式拍的**（`LIFE_BASE=0.3` / `LIFE_EMOTION_MAX=0.4` /
`FOLLOWUP_FACTOR=0.8` / `RELATIVE_KEEP=0.7` / 情绪词表），该由运行数据定。

### ✅ 观测日志已补（9-25），现在能收数据了

**`[Recall]` 一行一召，info 级**（刻意不用 debug —— 生产跑 info，debug 等于没记）：

```
[Recall] 候选 life=2 chat=3 conv=5 → 过阈值 life=2 chat=3 conv=5
         → 选中 life=2 chat=2 conv=1 | 重要度加分×2 | 333ms
```

捞数据：`docker logs alysia-server --since 7d | grep '\[Recall\]'`

**另外补了历史数据回填**：`scripts/backfill-life-importance.ts`（幂等、支持 `--dry`）。
接线前写入的向量没有 importance，不补的话"加分触发率"要等很久才有样本。
本地已回填 218 条（80 条超阈值），复跑探针确认 `重要度加分` 从恒 0 变成会动了。

**下一步（待你）**：部署到服务器 → 跑 ≥1 周 → 捞 `[Recall]` 日志 → 按分布调系数。
**先积累再调，不边跑边调** —— 否则"变化是谁引起的"无法归因。
统计脚本**暂不写**（用户 9-25「要捞再说」）—— 到时按当时的日志格式写，先手搓
`grep '\[Recall\]' | awk` 也够。

**初步信号**（等更多数据）：召回延迟 270-570ms/轮（embed 往返）；`RELATIVE_KEEP=0.7`
过滤得不频繁，可能该收紧。

---

## 本会话（9-25）完成：change `optimize-recall-pipeline`

**起因**：用户问"生活系统注入了哪些提示词层次"，查证时发现 `getLifeEventInjection` 的注释
写着"完整细节走向量检索召回"，而我**误判**它没实现（grep 漏了 `MemoryManager` 本体）。
实际 8-12 就做了。用户说"先验证召回效果"，于是写了探针 —— **结果发现召回本身是坏的**。

### 三个缺陷（探针实测）

| # | 问题 |
|---|---|
| 1 | **距离度量用错**：L2 + `score = 1−d`，而单位向量下 `d=1`（cos 仍 0.5）时 score 已归零 → 可用区间砍半 |
| 2 | **跨来源全局排序**：46 条 `life_event` 在 6 个话题里**一条都进不了最终 5 条**（长文本嵌入天然远 → 全塌 0 分 → 排序失效 → 被合并顺序饿死） |
| 3 | **无过滤**：无关话题也硬塞满 5 条 |

### 修法

1. `.distanceType('cosine')` —— 一行，`1 − _distance` 直接是余弦相似度
2. `mergeWithQuota`：**保底配额 + 分数补位**（每路先保底 top-1）
3. **路内相对阈值** `RELATIVE_KEEP = 0.7`（相对而非绝对 —— 绝对阈值会把长文本来源整路误杀）
4. **文本去重**（归一化后比较）

**核心洞察**：**路内排名可信，跨路比绝对分不可信**（不同来源文本长度分布不同）。

### 效果

| | 前 | 后 |
|---|---|---|
| 生活事件召回 | 6 话题 **0 次** | 每话题 **1-2 条** |
| 分数区间 | 几乎全 0.000 | **0.23 ~ 0.77** |

685 测试全过（+11）。探针脚本留在 `packages/server/scripts/recall-probe.ts`，改完可复跑。

### ★ 顺带查出两个问题

**① 同一条生活事件在向量库存两份**（47 条 life_event 里 23 条在 chat 里也有）——
`type='chat'` 的事件既被 `recordLifeEvent` 嵌一次、又被推送后经 `RealtimeProcessor` 嵌一次。
**刻意不删**：那两份语义不同（"她的生活" vs "她对你说的话"），`perspective` 过滤靠它区分。
改为合并阶段去重。

**② `webui-system`... 不，是 `memory-system` §3.3 的 doc/impl 分歧（未决）**：
spec 写的是加权融合 `向量距离×0.5 + 时间衰减×0.3 + 重要性×0.2`，
**该形式从未实现过**（一直是乘性衰减）。按对账规则该补实现，但"重要性"没有数据来源。
**待你定**：补加权融合 vs 认可现状改 doc。

**③ `importance_threshold` 旋钮完全空转** —— 四条写入路径没一条写 `metadata.importance`，
`+0.15` 分支从未执行。修它要先定义"什么算重要"。

---

## 本会话（9-25）完成：change `live2d-persist-across-pages`

**起因**：你问「为啥是先展示的球再变成昔涟」。实测确认是真问题 ——
**每次换页 Live2D 都完全销毁重建**（canvas 1→0→1，~500ms，还闪一次暖光球）。

**结果**：导航后 **0 模型请求、状态一直 ready、无闪现**。三页位置都正确，`/chat` 无槽位时
canvas**停靠隐藏而非销毁**，回来自动恢复。

### ★★ 两次撞墙（都记进 spec 了，别再踩）

**1. 把 canvas 搬进槽位 —— 直接崩**

```
NotFoundError: Failed to execute 'insertBefore' on 'Node': ... is not a child of this node
```
React 渲染出来的节点被搬走 → React 丢失父节点认知 → 整页白屏。
**React 管的 DOM，不要改它的父节点。**

最终方案：**canvas 留在原地**，页面只注册"槽位矩形"，层用 `transform: translate()`
把 canvas **覆盖**到矩形上（文档坐标系，随页面滚动）。

**2. `model.width` 是"已缩放后"的宽度**

拿它当缩放分母 → 每次重算再乘一遍 → 200ms 复测循环把模型放大成**特写**。
修：加载时缓存**未缩放**基准尺寸。

**3. 外加一个**：context value 没 `useMemo` → 消费方 effect 重注册 → 无限重渲染
（`Maximum update depth exceeded`，整页卡死到导航都点不动）。

### ★★ 追加：贴图瘦身（用户反馈"感觉没变化"后才找到的真问题）

**我一开始修错了方向，如实记录**：那套持久化只消除**换页重复**的代价，而用户看的
是**首屏**那次「球 → 昔涟」—— 完全没动。用户说"没变化"是对的。

量出根因：

```
texture_0.png  8192 × 8192   8.59 MB
实际显示       ~334 × 380 px        → 每方向超采样 24 倍
```

首屏 1.8s 基本全在解码这张 8K 图。降到 **2048²（0.86 MB）**：

| | 之前 | 之后 |
|---|---|---|
| 首屏 loading→ready | 1.8 s | **0.68 s** |
| 模型目录 | 9.1 MB | 1.4 MB |
| `out/` | 12 MB | **3.6 MB** |

画质 2× DPI 截图确认无肉眼差别。**原图备份在 `E:\workSpace\.texture-orig.png`**
（webui 里那份 8192² 原图也还在）。

**工具坑**：`C:\Windows\System32\convert` **不是 ImageMagick**，是磁盘转换工具。
缩放用 PowerShell 的 `System.Drawing` 即可，零安装。

### 遗留

- **首屏 0.68s**：比原来好 2.6 倍，但仍有短暂暖光球。要彻底消除得**去掉占位球**
  （留白或换同形状占位）—— 未做，等用户定
- **最脆的一环**：槽位位置靠 ResizeObserver + 布局稳定期 200ms 轮询复测。
  异步数据到达会撑动 hero（位置变、尺寸可能不变，RO 抓不到）。**模型错位优先查这里**

---

## 本会话（9-25）完成：change `migrate-live2d-to-console`

Live2D 从 webui 迁到 console，**进各页 hero**（用户拍板）：
`/life` 320 / `/dashboard` 230 / `/` 380；小尺寸（气泡 34 / 顶栏 44 / CTA 120）**仍用 SVG 暖光球**
——给 34px 塞 3D 模型是荒谬的，这是设计分工不是遗漏。

**实测**：三页 `data-live2d="ready"`、模型真的渲染（画布采样 22.5% 不透明）、
674 测试全过、`out/` 1.6M → **12M**。

### ★ 「859 行原样搬」是错的 —— 踩出 7 个问题

| # | 问题 |
|---|---|
| 1 | `focus.ts`/`speaking-motion.ts` **是死代码**（无人引用）→ 实际只有 682 行，死的不搬 |
| 2 | `expression-reset.ts` 是 **GBK 编码**（`.ts` 里混了 GBK 字节）→ Vite 容忍、**Turbopack 直接报错**。已修（webui 原文件同样坏，一并修） |
| 3 | `manager.ts` 的 `transparent: true` **在 Pixi v7 不存在**（v6 遗留，静默忽略）。webui 从不类型检查（`build` 是裸 `vite build`）所以没暴露 |
| 4 | **Cubism 运行时必须在 import 之前就绪** —— `pixi-live2d-display/cubism4` 在**模块求值阶段**就检查全局。顺序反了必崩（且在 import 期抛错会**崩整页**，兜底都没机会） |
| 5 | **StrictMode 复用 canvas → context 被丢弃** —— Pixi `destroy()` 会 `loseContext()`，React 复用 DOM 节点 → 二次挂载拿到死 context，`MAX_TEXTURE_IMAGE_UNITS` 返回 0 → Pixi 抛错。**canvas 必须由 effect 自建** |
| 6 | **`applyZoom` 把画布撑成整个浏览器窗口** —— `resize(window.innerWidth, innerHeight)` 是 Electron「窗口即容器」假设；浏览器里画布变 756×488 而容器只有 203×260，**画面全空** |
| 7 | `baseScale` 有「绝不放大」上限（桌宠策略）；hero 要填满 → 加 `fit` 选项 |

**另**：Cyrene 是 **Q 版模型**（可见包围盒 163×144，近方形），容器比例 0.78 → 0.88。

### 新增诊断手段（CDP，零依赖，以后排查渲染问题必备）

```bash
node cdp-probe.mjs <url> [ms]     # 抓浏览器 console / 异常
node shot.mjs <url> <png> [秒] [宽] [高]   # 真实等待后截图（虚拟时间会破坏 rAF 渲染）
node eval.mjs <url> <expr.js> [秒]  # 页面内 eval（读 WebGL 参数 / 量模型包围盒）
```
（Node 24 自带 WebSocket，不需要 puppeteer。临时脚本在 `.tmp-shots/`，用完已删）

**关键教训**：`--virtual-time-budget` 快进时间会**破坏 rAF 驱动的渲染**，
截图会显示空白但模型其实是好的 —— 别据此误判。要真实等待。

**可观测**：容器带 `data-live2d="loading|ready|fallback"`，静默退化一眼可辨。

### 现在的状态

- **`packages/webui` 三个删除约束全部解除**（Electron ✅ / pet.html ✅ / Live2D ✅ 已迁）
  → 可以删了，但需另开 change 走完整流程
- **遗留**：`soul.md` 的「Live2D 桌面空间」用户决定另开 change 改；
  `play_live2d_action` 工具等交互待办未做（`window.live2d` 接口已就绪）

---

## 本会话（9-25）完成：change `drop-electron-desktop`

用户决定：**Electron 桌面端砍掉**。

| 项 | 内容 |
|----|------|
| 删除 | `packages/desktop/`（4 文件）、console 的 `/desktop` 预览页、`app-shell` 的「桌面端」导航 |
| 连带 | **删除 `lib/mock-data.ts`** —— 删掉 desktop 页后无任何引用，它是 mock 臆造字段（口语化/稳定性/情绪记忆/主动唤起）的源头 |
| route | console 6 → 5 个路由；`/desktop` 现 404 |
| spec | `webui-system` §8 整节划掉、`alysia-architecture` 3 处、`alysia-console` §1/§8 |

**★ 发现 `webui-system` §8 早就是错的**：它写桌面端是「AlysiaCore(本地 userData db) +
createWebuiApp(随机端口)」，实际实现是 fork `packages/server` + **固定 6185** +
**共用 `packages/server/data`**。已按实际记录。

**⚠️ 桌面端与本地 server 同端口同库**（都 6185 / 都用 `packages/server/data`），
两个同开时子进程绑不上端口（静默失败）——删除同时也消掉了这个隐患。

**保留**：`ALYSIA_DESKTOP` / `IS_DESKTOP` 开关（语义降级为"跳过 IM 适配器与主动推送的
UI-only 本地模式"，不再有 Electron 壳去设置它）。

### 废掉 webui 的约束：3 → 1

| 约束 | 现状 |
|---|---|
| Electron 壳 | ✅ 已删 |
| `pet.html` | ✅ 随 Electron 失去宿主 |
| **Live2D** | ⏳ 用户决定**迁往 console** |

**下一步 change：`migrate-live2d-to-console`** —— 迁完即可整体删除 `packages/webui`。
⚠️ Live2D 写在她的 persona 里（`soul.md` §356 / §11），迁移要同步考虑这套自我认知表述。

---

## 本会话（9-25）完成：change `wire-console-chat`

把 `/chat` 从「演示数据」换成真链路（服务端 `webui-chat-endpoints` 8-15 就做好了）。

| 项 | 内容 |
|----|------|
| 流式 | `lib/api/stream.ts`：SSE 解析 + **`AbortSignal` 真的接进 `fetch`** |
| 页面 | 真会话列表 / 历史回放 / 逐字流式 / 「她想了想」折叠思考条 / 停止按钮 / 新会话 / 归档 / 删除 / 重命名 |
| reasoning | `kind='reasoning'` 进思考条，**绝不混进正文**；`kind='text'` 进正文 |
| 测试 | `tests/stream.test.ts` 13 用例（含三种分片边界 + abort 语义） |

**★ 顺手修掉 webui 的一个坏按钮**：它的停止按钮建了 `AbortController` 并 `abort()`，
但 `streamChat` 的 `fetch` **从未接收 signal** —— 请求照跑，界面只是假装停了。
console 实现接上了 signal（中止抛 `StreamAbortedError`，与网络错误区分）。

**⚠️ 契约不一致（已绕过，值得记）**：归档/删除路由用**原始 id** 做 `startsWith('webui:')`
校验（必须带 `webui:private:` 前缀），而会话列表给完整 id、chat 路由却用 `cleanSid` 兼容裸 id。
传裸 id 会 **403「QQ 会话不可删除」**。webui 靠"删除传完整 id / 切换传裸 id"混用绕过；
console 改为显式补前缀。

**实测**：SSE 直连拿到 `connected` → 逐字 `reasoning` → 回复落库；
无头 Edge 确认页面「演示数据」「未接入」**双双归零**，会话列表实时渲染。
probe 会话已删净。

**未接**：表情包 `[表情包:名字]` 渲染（现按纯文本显示）、`/api/chat/pending`（刷新后恢复"回复中"状态）。

---

## 本会话（9-25）完成：change `add-life-readonly-endpoints`

补上两个「core 有方法、无路由」的只读出口：`GET /api/life/summaries`（每日摘要，
窗口固定 7 天）、`GET /api/life/companions`（配角在场，含 `off-scene`）。
console 侧加了适配（`adaptSummaries` / `adaptCompanions`）与 6 组单测。

**坑**：`formatSummaryDate` 不能用 `new Date('2026-08-27')`——那是 UTC 午夜，
**负时区会退回前一天**，日期标签错一天。改按本地日历构造，测试锁定。

**实测**（无头 Edge `--dump-dom`）：`/life` `/dashboard` 均**零「未接入」**、
零报错；`/life` 渲染出摘要 13 条、配角 3 条状态、素材库两组标签。
`/personality` 剩 1 个（护栏，确实无接口）、`/chat` 整页待做。

### ★ 新增的验证手段（本会话发现，很好用）

**用机器上现成的 Edge 做无头截图 + DOM dump，零安装**：

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
# 截图（然后用 Read 工具读 PNG，人眼可看）
"$EDGE" --headless=new --disable-gpu --hide-scrollbars --window-size=1440,3000 \
  --virtual-time-budget=9000 --screenshot=/path/out.png "http://localhost:3000/life"
# JS 执行后的 DOM（精确断言用）
"$EDGE" --headless=new --disable-gpu --virtual-time-budget=9000 --dump-dom "URL"
```

`--virtual-time-budget` 给客户端 fetch 留时间（静态导出的数据是客户端拉的）。
**注意**：Claude Code 自带的 computer use 只支持 macOS，Windows 用不了；
但上面这招能覆盖"验证前端渲染"的需求。

---

## 本会话（9-25）进行中：change `deploy-console-remote`

**动机**：用户想接入**服务器上那个跑了 24 小时的实例**（真实 QQ bot + 数周生活积累），
本地这份只是开发副本。而镜像里**从来没有前端产物**（Dockerfile 只 COPY core+server），
所以 `<SERVER_IP>:6186` 一直只有 `/api/*`、没有界面。

| 项 | 内容 |
|----|------|
| Dockerfile | runtime 阶段 `COPY packages/console/out`（本地先 `pnpm build:console`；不在 Docker 里构建——`next build` 要联网下字体） |
| SOP | Step 2 加构建前端步骤 + 「`out/` 旧了会静默打包旧前端」告警；Step 3 加打包前 `host` 自查 |
| 容器行为 | 保持 `0.0.0.0` + 强制鉴权（不套用本机回环配置） |

**⚠️ 未验证**：本机 Docker Desktop 未运行 → **镜像构建未实测**。改动只有一行 COPY，
但必须实跑一次 `docker compose build` 才算数。远端步骤需服务器凭据，由用户执行。

**另一条路（不部署）**：`ALYSIA_API=http://<SERVER_IP>:6186 pnpm dev:console`，
粘服务器自己的 `ALYSIA_WEBUI_TOKEN`（与本地那个不同）。适合临时看，不适合日常。

---

**未做（后续 change）**：聊天流式、管理页迁移（世界书/知识库/角色）、Docker 远端部署、废弃 webui
（需先安置 Live2D 资产 / Electron 壳 / pet.html）。

**✅ 原两个后端缺口已补**（change `add-life-readonly-endpoints`，2026-09-25）：
`GET /api/life/summaries`、`GET /api/life/companions` 已上线，console 的「每日生活摘要」
「她的世界」两栏从 `NotWired` 换成真实数据。`/life` 与 `/dashboard` 现在**零「未接入」**。

**⚠️ 已挂起的 backlog**：`console-a11y-motion`（17 处动画缺 `prefers-reduced-motion` 守卫；
hero 渐变标题在 `forced-colors` 下可能不可见）—— 用户指示先记档、暂不实现。

**未覆盖**：桌面模式（`ALYSIA_DESKTOP=1`）未在真机启动 Electron 验证（代码路径与改动前一致，回归风险低）。

---

## 上一会话（8-29 ~ 9-01）完成

"昔涟"生活系统完成 **锁续期调度重构 → 公共底色集中 → L3 每日反思闭环**；
**本地服务 + 服务器容器均已部署最新代码（commit `97d7d29`）**，测试 core 422 + server 151 全绿。

## 本会话（8-29 ~ 9-01）完成的 change（全部已归档）

| change | 内容 |
|--------|------|
| `cr-p0-webui-auth` | WebUI Bearer token 鉴权（fail closed / 桌面免鉴权 / health 豁免）；提交前敏感审查：token 在 .env（已 gitignore），config.yml 整文件 gitignore |
| `cr-p0-delete-cleanup` | deleteSession/deleteKnowledgeDoc 同步清向量；5 处空 catch 补日志 |
| `cr-p0-session-isolation` | ConversationStore 按完整 sessionId 精确匹配（跨群/跨平台摘要泄漏封死） |
| `life-schedule-renewal` | **锁续期调度**：成功按模型 0.5-8h / 失败保底 / 异常 try-catch 兜底（P1-6 33h 停摆实证修复）；时段保底（白天 1h / 夜间 2h）；chat 上限 5→20；补写随 gap 渐变；延续链 ≥3 开新事；剧情链 24h 窗口 |
| `worldview-fixed-setting` | 跨世界之窗定位为固定设定（此前被"不要每件事都提"压没） |
| `worldview-centralize` | 公共底色集中：`persona/worldview.md` 唯一数据源 + `persona/INDEX.md` 注入点地图 |
| `life-reflection-loop` | **L3 每日反思闭环**：跨天触发 → LLM 反思 → adjustments 走护栏调人格（Δ≤0.05）/ insight 进画像 / reflection 存 ai_life_state。**不推送**（纯内部） |

附带修复：P3-27 webui 悬空 import（vite build 恢复）。

## 待观察（下一会话优先检查）

1. **每日反思首次运行**：9-01 午夜后，服务器日志应出现 `[Reflection] 2026-09-01: <她的话>`——看质量与是否乱调人格
2. **锁续期密度效果**：`[Life] lock renewed +X.Xh (model: default|1.5|2.5)` 日志——模型给值比例、事件数（预期白天 ~15 internal + chat 3-8 条/天）
3. **跨世界之窗是否生效**：事件/聊天回复里"隔着世界"是否在相关时刻自然浮现（固定设定强度验证）
4. **意图推送"想告诉轻月："句式**：已确认**接受为她的设定**（不改）——她心里想到什么就直白说出来

## 未决 / Backlog

- **CR 剩余项（P1-P3）**：P0 三件套已修。剩余见 `docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md`——
  已业务复核：6 项误判（P2-17 群聊串行=设计/P1-9 WebUI reminder 无入口/P1-10 配额过度设计/P2-18 错误文本/P3-34 worldview 缓存/P2-25 无调用方）；其余按 P1 优先级排
- 记忆旋钮进召回管道（backlog）、`/api/platforms`、worldbook 采样 cooldown
- WebUI 前端（契约就绪）、Reminder 持久化 SQLite、桌面端

## 环境速查

| 项 | 说明 |
|----|------|
| 本地跑 server | `cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx src/bootstrap.ts`（Node 24 必需；PATH 里 node 是 v20 会 ABI 不匹配） |
| **新前端 console（开发）** | `pnpm dev:console`（= `cd packages/console && next dev`，3000，rewrites 代理 /api → 6185）。**必须用 corepack，根 pin 了 pnpm@9.15.0**；直接用系统 pnpm 12 会改写 lockfile 格式，破坏 Docker 的 `--frozen-lockfile` |
| **新前端 console（本地部署）** | ① `pnpm build:console`（产出 `packages/console/out`）② 起 server → **`http://localhost:6185` 直开就是新前端**（同源，一个进程，无代理）。产物不存在时自动回退 webui 并打日志 |
| **core 改动必须 build** | `cd packages/core && npm run build`（server 走 tsx 跑 src，但 @alysia/core 走 symlink 的 dist/） |
| 测试 | 单个包：`pnpm --filter @alysia/core test`（e2e 要 `--exclude='tests/memory/e2e/*'`）／`--filter @alysia/server`／`--filter @alysia/console`；根 `pnpm test` 跑全部（2026-09-24 修好，此前空跑失败） |
| console 与 webui 的关系 | 两个前端共存，共用一个 `webui_token`；webui 待废弃。**新增/改端点要同时考虑两者** |
| 前端分流 | 服务模式 → console；桌面模式（`ALYSIA_DESKTOP=1`）→ webui（Electron 壳依赖 hash 路由/Live2D/pet.html） |
| ★ 鉴权边界（9-24 修） | 钩子**只守 `/api/*`**，静态资源与页面公开。此前钩子拦下所有请求，浏览器打开 `/` 拿 401、前端页面加载不出来（详见 `server-hardening` spec §6.1） |
| 服务器部署 | 见 `docs/Docker-Deployment.md`（构建→save→scp→load→up -d --force-recreate）；每次必做：本地 docker compose build（Docker Desktop 需在跑） |
| 服务器 WebUI 鉴权 | `ALYSIA_WEBUI_TOKEN`（服务器 `~/alysia/.env`），compose 透传；无 token 时 /api/* 全 401（fail closed） |
| **本地免鉴权** | `packages/server/config.yml` 已设 `host: "127.0.0.1"` → 只绑回环、局域网够不着、**不用输 token**。改回对外地址会自动恢复鉴权 |
| ⚠️ **改配置只改 `packages/server/config.yml`** | 根目录的 `config.yml` **是死文件**（服务从 `packages/server` 启动，读 `cwd/config.yml`）。改错文件没有任何提示 |
| 本地 WebUI token | 根目录 `.env` 的 `ALYSIA_WEBUI_TOKEN`（现在只在对内可达时才用得上） |
| 数据 | 服务器 `~/alysia/data` 卷挂载（alysia.db / life-state.json / LanceDB / logs），镜像更新数据不丢；迁移一律 ALTER TABLE + try-catch 不 DROP |

## 关键约定（勿踩）

1. **OpenSpec 流程**：任何行为变更先 `/openspec-change` 建骨架 → 实现 → 合并 spec → 归档 → 更新 index.md。禁止直改不 archive。
2. **敏感审查**：提交前检查——`.env`/`config.yml` 已 gitignore；`docs/Docker-Deployment.md` 永不提交（含密码）。
3. **不静默吞错**：外部交互必须检查响应体 + 打日志（项目硬约束）。
4. **网络**：GitHub push 直连不稳定，重试或开 Clash（127.0.0.1:7890）。
5. **聊天回复"想告诉轻月："句式**是接受的设定，不要"修"它。

## 系统现状（她的一天应该长什么样）

```
白天: internal 1h 节奏（生活积累）+ chat 3-8 条/天（推送,20 上限 + 1h 冷却）
夜间 0-7h: 2h 节奏（睡觉/安静,模型想聊可提前到 0.5h）
跨天: 每日摘要 + 每日反思（她复盘自己 → 人格微调 + 洞察进画像）
公共底色: 跨世界之窗（固定设定）/ 独立生活 / 生活中心——persona/worldview.md 唯一数据源
```

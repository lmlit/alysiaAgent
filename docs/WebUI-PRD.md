# WebUI 产品需求文档（PRD）

> 日期:2026-08-15 | 状态:初稿 | 维护:后续子需求逐项走 OpenSpec change
> 参考:docs/Web-API-Design.md(服务端契约)、dsh web(deepseek-harness,传输/交互参考)

## 1. 背景与目标

Alysia(昔涟)当前能力全部跑在服务端(QQ 机器人),所有数据与交互都隔着 QQ 消息。
WebUI 是她的**管理面板 + 聊天窗口**——本地方便地看她、改她、和她聊。

**本次目标**:
1. 一个**运行在本地的 Web 项目**(与 dsh web 同形态:本地起服务 → 浏览器访问 127.0.0.1)
2. 一期交付**聊天模式全量**:管理面板(看数据/调参数/管理条目)+ 聊天视图(和昔涟对话)
3. 二期对照 dsh 做**编程模式**(agentic coding 视图),本次不交付

## 2. 整体规划（壳分离,一步到位 Electron）

> 抄 dsh 思路:前端与壳解耦——同一套 Vue SPA,Electron 是主形态,浏览器是衍生形态。

| 形态 | 壳 | 内容 | 参考对象 |
|---|---|---|---|
| **主形态:Electron 桌面应用** | Electron 43 + 内嵌 Fastify | 管理面板(11 页)+ 聊天视图(流式/表情包/打断)+ **Live2D 桌宠全功能**(透明窗口/置顶/点击穿透/拖窗/口型)+ 动作工具;主进程跑**本地完整实例**(本地 SQLite + pipeline,features.codeMode=true) | **Cyrene 全套照抄** |
| **衍生形态:浏览器访问** | 浏览器(可选) | 同一 SPA 由内嵌 Fastify 托管,localhost 访问——**管理面板可用,Live2D 桌宠不可用**(Electron 专有) | dsh web |

**架构(抄 dsh 壳分离)**:
```
┌─ Electron 主进程 ──────────────────────────────┐
│  Alysia core(本地实例:记忆/pipeline/工具/Life) │
│  Fastify(内嵌,托管 SPA + /api)                │
│  BrowserWindow × N(管理面板/聊天 + Live2D 桌宠)│
└────────────────────────────────────────────────┘
     ↓ 同源 /api + 事件流
Vue SPA(一套代码):管理面板 + 聊天视图 + Live2DCanvas
```

- 一期不做"浏览器管理远程服务器"场景(本地项目定位);若将来需要,同代码部署服务器
- Live2D 一步到位全功能,无浏览器降级版

## 3. 产品定位

```
WebUI = 本地工具 + 完整前端
├─ 管理面:她的全部状态可视可调(画像/人格/记忆旋钮/角色/知识库/生活/世界书/模板/统计)
├─ 聊天面:会话列表 + 流式对话(走同一套记忆/人格/生活系统,与 QQ 通道共用后端)
└─ (二期) 编程面:对照 dsh(会话树/工具树/审批/终端/diff/context meter)
```

与 dsh 的关键差异:WebUI 不是独立产品,是 **Alysia 服务的界面**——数据源是同一份
SQLite + 记忆系统,聊天走同一条 pipeline。因此**服务端是权威,前端只做投影**(dsh 的
"事件即真相 + 快照投影"思想)。

## 4. 用户场景

| 场景 | 用户动作 |
|---|---|
| 管理她的记忆 | 打开画像页看昔涟记住了什么 → 手动调整/清理事实 |
| 调她的性格 | 人格页拧记忆旋钮(decay/importance/recency…)→ 看即时生效 |
| 审计自进化 | 世界书页按 source=self 筛出她自己写的新条目 → 不想要的删掉 |
| 看她的一天 | 生活页看亲密度曲线/今日事件流/每日摘要/生活模板池 |
| 和她聊天 | 聊天页选中会话 → 打字 → 她流式回复(带表情包标记) |
| 换角色 | 角色页切换激活角色,导入导出角色包 |

## 5. 功能需求

### 5.1 全局框架（P0）

- 三栏布局:左侧导航(模块菜单)| 主内容区 | (聊天视图为左右分栏:会话列表 + 对话区)
- 深色主题(星穹紫金配色,沿用 feature-overview 页视觉);明暗两套随系统
- 顶部:连接状态指示(服务在线/离线)、当前激活角色、亲密度徽章
- 响应式:桌面优先,窄屏降级为单栏 + 抽屉导航

### 5.2 管理面板（P0）

| 页面 | 数据/操作 | 服务端来源(已有) |
|---|---|---|
| 画像 | 展示 basics/preferences/facts,手动调整 | `getProfileSnapshot` / `extractProfile` |
| 人格 | 3 维参数可视化 + 手动 adjust + 记忆旋钮滑块 | `getPersonaSnapshot` / `adjustPersona` / `getMemoryConfig` / `adjustMemoryConfig` |
| 会话 | 会话列表(时长/消息数/最近活跃)+ 手动提取画像 | `listSessions` / `extractProfile` |
| 角色 | 列表/切换/导入(JSON 上传)/导出/查看世界书 | `listRoles` / `switchRole` / `importRole` / `exportRole` |
| 知识库 | 文档列表/导入(文本)/删除 | `listKnowledgeDocs` / `importKnowledge` / `deleteKnowledgeDoc` |
| 生活 | 快照 + 近 7 天事件流 + 每日摘要 | `getLifeSnapshot` / `listLifeEvents` / `listLifeSummaries` |
| 世界书 | 全部条目(含 source 标记)+ 删除(事后改闭环) | `listWorldbookEntries` / `deleteWorldbookEntry` |
| 生活模板 | 模板池列表(seed/self 标记)+ 删除 | `listLifeTemplates` / `deleteLifeTemplate` |
| Token 统计 | 全局 + 分会话用量 | `getTokenStats` |
| 表情包 | 列表预览 | `listStickers` |
| 隐私模式 | 三档开关 | `setPrivacyMode` / `getPrivacyMode` |

### 5.3 聊天视图（P0）

- **会话列表**:会话侧栏(标题/时间/消息数),新建会话,切换会话
- **对话区**:消息流渲染
  - 用户消息 + 昔涟回复(markdown 渲染,代码块高亮)
  - 表情包:`[表情包:名字]` 标记渲染为图片(复用 sticker 目录)
  - 思考中指示:等待回复时显示"想着…"状态(复用 thinking 文案池)
  - 流式输出:逐块渲染 LLM 回复(见 7.2 依赖)
- **输入区**:文本框 + 发送;发送后追加用户消息并滚动
- **打断**:回复生成中允许停止(触发 cancel 语义,丢弃在途结果)
- **Live2D 小人**:对话区角落常驻昔涟小人(详见 5.4),心情/亲密度驱动表情,支持动作工具触发

### 5.4 Live2D 集成（Electron 全功能,照抄 Cyrene 全套）

> 参考:E:\workSpace\Cyrene-Agent(同人设 Electron 桌宠,昔涟模型 + 完整渲染层 + 窗口件)。
> 许可证:模型作者「是依七哒」授权个人使用/修改/再分发(署名),**不可商用**——alysia 合规 ✅

**渲染栈**:pixi.js 7 + pixi-live2d-display 0.5.0-beta + `live2dcubismcore.min.js`(207 KB 全局脚本)

**迁入文件**(渲染层 + 窗口件全量照抄):
| 源文件(Cyrene) | 用途 | 搬迁动作 |
|---|---|---|
| `public/models/cyrene/` | 模型(Cubism4,9.48MB:model3.json/moc3/4K纹理/motions×5/expressions×12) | 拷入 `packages/webui/assets/live2d/`;**纹理 9MB 预压缩** |
| `renderer/live2d/manager.ts` | 模型加载/缩放(baseScale 固定基准窗 400×500 防 zoom 双重计入)/动作播放 | Vue 封装 `<Live2DCanvas>` |
| `renderer/live2d/mouth-sync.ts` | 口型同步(时长驱动:定时器翻转 ParamMouthOpenY + 随机抖动) | 照抄,预留 TTS 接线 |
| `renderer/live2d/speaking-motion.ts` | 说话时荡秋千动作切换 | 照抄 |
| `renderer/live2d/interaction.ts` | 点击命中区 → 对应动作(hitTest + 位移阈值 5px) | 照抄 |
| `renderer/live2d/expression-reset.ts` | 3 分钟自动回正表情(**坑:源码默认表情名乱码,应为"表情回正"**) | 照抄 + 修复 |
| `renderer/live2d/focus.ts` | 鼠标跟踪注视 + **全局光标轮询**(IPC `screen.getCursorScreenPoint`) | 照抄(含 IPC) |
| `renderer/main.ts` 拖窗段 | 拖窗 + capturePage 拖影消除 + ticker 暂停 | 照抄 |
| `renderer/live2d/click-through.ts` | 点击穿透(像素采样 + setIgnoreMouseEvents) | 照抄 |
| `shared/live2d-actions.ts` | 10 个动作中文别名目录(回正/眨眼/可爱/墨镜/问号/闪耀/星星眼/圈圈眼/开心眼…) | 照抄 |
| `main/index.ts` 桌宠窗口段 | BrowserWindow(400×500 透明/无边框/置顶 screen-saver 级/skipTaskbar)+ 移动控制器 + 缩放 | 照抄 |
| `preload/index.ts` live2d 命名空间 | `cyrene` / `live2dSpeech` / `live2dAction` IPC 通道 | 照抄精简 |

**动作工具**(`play_live2d_action`,注册进 chat tools):
- LLM 中文别名 → `findAction` 校验 → 解析 target → 组件执行(渲染层不见原始别名)
- 情绪→动作映射**不硬编码**(照抄 Cyrene 设计取舍):LLM 自主决定调哪个动作,提示词带动作目录
- 可选:getLifeSnapshot 的 mood/intimacy 驱动默认表情(开心→开心眼,亲密度高→星星眼)

**窗口形态**:聊天窗口内嵌小人 + 可选独立透明桌宠窗口(置顶/穿透/拖窗,照抄 Cyrene 桌宠窗口)

### 5.5 二期:编程模式（P2,本次不做）

对照 dsh checklist 完整列在 `docs/WebUI-PRD.md` 附录 A(dsh 功能面对照表),届时单独开 PRD/change。

## 6. 非功能需求

- **安全(Electron 内嵌为主,浏览器为衍生)**:主形态渲染进程加载本地页面,无网络攻击面;
  内嵌 Fastify 默认监听 127.0.0.1 且拒绝 0.0.0.0(浏览器衍生形态可访问),保留 dsh 式
  信任围栏(Host loopback 校验 + cross-site 403)作为兜底;**无鉴权**(本地单用户);
  特权操作(删除/调整)二次确认;contextIsolation: true / nodeIntegration: false(照抄 Cyrene)
- **性能**:聊天消息列表按需分页(不一次拉全量);流式渲染节流(≤3 帧/秒视觉更新)
- **可维护**:Vue3 + TypeScript 严格模式;状态单一来源(Pinia);组件按页面目录划分
- **测试**:前端 Vitest 组件测试 + 手动 e2e 冒烟;API 复用现有服务端测试

## 7. 技术方案

### 7.1 栈与形态

| 层 | 选择 |
|---|---|
| 前端 | Vue 3 + Vite + Pinia + vue-router;CSS 变量主题,无组件库(轻依赖,参照 dsh 的样式纪律) |
| 壳 | **Electron 43**(照抄 Cyrene 模板:多窗口/preload/IPC/透明桌宠窗口);主进程内嵌 Fastify |
| 目录 | 新 monorepo 包 `packages/webui`(前端 SPA)+ `packages/desktop`(Electron 壳,照抄 Cyrene)+ server 内新增 webui 路由扩展 |
| 运行 | `pnpm desktop:dev` 起 Electron(主进程起 Fastify + 加载 SPA);`pnpm webui:dev` 纯浏览器形态(可选) |

### 7.2 传输与流式

- 上行:`POST /api/<method>` unary(沿用现有 Fastify 路由风格,统一 `{ok, error}` 信封)
- 下行:**SSE**(`POST /api/chat/stream`,fetch 可读流)——本地单用户场景下 SSE 比 WebSocket
  更简单,足以支撑聊天流式 + 状态推送
- 聊天消息注入与 dsh 不同:**走现有 pipeline**(记忆/人格/生活全链路),不是独立 agent 循环

### 7.3 服务端新增（P0 前置）

| 端点 | 用途 |
|---|---|
| `POST /api/chat/prompt` | 注入用户消息进 pipeline,返回完整回复(非流式兜底) |
| `POST /api/chat/stream` | 同上,SSE 流式(依赖 streaming pipeline) |
| `GET /api/sessions/:id/messages` | 会话消息历史(分页,按消息边界) |
| `GET /api/chat/pending` | 当前是否有在途回复(断线恢复状态) |

依赖项:**streaming pipeline 改造**(backlog:LLMAgentStage → textChatStream)是本 PRD 的
P0 前置,与 WebUI 前端并行开发。

## 8. 扩展点规划（编程模式预留）

> 原则:**二期编程模式 = 新增文件 + 注册项,不改动一期文件**(共享基础设施除外)。
> 一期验收标准含此约束。

### 8.1 前端扩展点

| 扩展点 | 一期实现 | 二期接入方式 |
|---|---|---|
| 路由与导航 | 导航菜单 = 模块表常量 `modules.ts`({id/title/path/icon/view 组件}) | 表里加一行 + 新建 `views/programming/` 目录 |
| API client 分层 | `api/client.ts`(unary + SSE 统一封装)+ `api/modules/<域>.ts` 按域分组 | 新增 `api/programming.ts`,不碰现有域文件 |
| 消息节点渲染 | 聊天消息 = **节点类型→组件映射表**(renderer map) | 工具调用/审批节点 = 注册新组件,聊天容器零改动 |
| 通用组件池 | 一期沉淀:卡片/表格/折叠/JSON 视图/markdown/分页/滚动容器 | 工具树/终端块/diff 视图复用其基础 |
| 会话侧栏 | 会话列表 = 纯数据渲染(无模式逻辑) | 编程会话(带 workspace)复用同一列表组件 |

### 8.2 服务端扩展点

| 扩展点 | 一期实现 | 二期接入方式 |
|---|---|---|
| 消息注入入口 | `POST /api/chat/prompt` 统一入口,支持 `pipelineMode: 'chat' \| 'code'`(core 已具备该字段) | 编程模式 = 同入口 + mode='code',零新增入口 |
| SSE 事件通道 | `chat/stream` 按 **event type** 扩展(回复块/status/thinking) | 工具调用事件 = 新增 event type,同通道下行 |
| 工具调用事件暴露 | pipeline 已有 tool 调用过程,一期不暴露 | 二期把 tool-call 结构化事件接入 SSE |
| 审批钩子 | 一期不建(codeMode 工具暂无确认) | 二期 M0:工具注册层加 approval 前置回调 |

### 8.3 规划

- 二期编程模式 = **独立 PRD**,附录 A 为其输入清单
- 一期验收标准增加:模拟二期接入(新增编程域目录 + 注册),确认零改动一期文件

## 9. 优先级与里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|---|
| M0 服务端就绪 | chat prompt/stream/messages 端点 + streaming pipeline | streaming 改造 |
| M1 前端骨架 | Vite 工程 + 布局/主题/导航 + API client | M0 部分 |
| M2 管理面板 | 5.2 全部页面(先数据展示,后操作) | M1 |
| M3 聊天视图 | 会话列表 + 消息流 + 流式 + 表情包 + 打断 | M0 + M1 |
| M4 Electron 壳 + Live2D 全功能 | 主进程(本地实例 + 内嵌 Fastify)+ 桌宠窗口(透明/置顶/穿透/拖窗)+ Live2DCanvas + 动作工具 | M2+M3 + Cyrene 全套迁入 |
| M5 打磨 | 连接状态/错误态/空态/托盘/打包 | M4 |
| M6 (二期) | 编程模式(对照 dsh 附录 A,走 8.1/8.2 扩展点) | 单独 PRD |

## 10. 风险

| 风险 | 缓解 |
|---|---|
| streaming pipeline 改动影响 QQ 通道 | 流式只新增不走改旧:chat/stream 独立路径,QQ 保持现状;全量回归测试 |
| 聊天视图与 QQ 会话状态不一致 | 服务端为权威,session 状态全部从 API 读取,前端不做本地缓存幻影 |
| 桌面端本地库与服务器生产库不同 | 桌面端跑本地库(完整实例);服务器 QQ 通道保持现状,两者互不影响;浏览器衍生形态可选管理服务器(后续决策) |
| Electron 壳复杂度(窗口/打包) | 照抄 Cyrene 已验证模板,不原创窗口逻辑 |
| Live2D 模型 9MB 单纹理首屏慢 | 纹理预压缩(降采样/WebP)+ 懒加载(进聊天视图才 init pixi) |
| Live2D 库与模型兼容(Cubism 版本) | 锁定 pixi-live2d-display 0.5.0-beta + live2dcubismcore.min.js 版本(与 Cyrene 完全一致,已验证可跑) |
| 模型许可边界 | 不可商用、需署名——README 与页面 footer 标注模型来源(是依七哒) |

## 附录 A:dsh 编程模式功能面对照表（二期参考）

| dsh 功能 | 说明 | 二期映射 |
|---|---|---|
| 会话树/workspace | 会话按工作区组织 | 会话侧栏增强 |
| turn/step/tool-call 事件粒度 | agent 循环生命周期 | runner 事件补齐 |
| 工具调用树 + 每工具视图 | 工具执行可视化 | codeMode 工具视图 |
| 审批面板 | shell/写文件风险确认 | **必需先做**(当前 codeMode 无确认) |
| TerminalBlock/DiffBlock/FileTree | 结果渲染 | 按 Vue 重写 |
| ContextMeter + compaction 提示 | token 预算可视化 | TokenBudget 增强 |
| todo/goal | 任务清单状态机 | 移植逻辑 |
| session fork | 从历史切子会话 | 移植 |

## 附录 B:Cyrene-Agent 借鉴清单（Live2D 渲染层 + 设计系统）

> 源:E:\workSpace\Cyrene-Agent(Electron 昔涟桌宠,pixi.js 7.3 + pixi-live2d-display 0.5.0-beta,cubism4)
> 模型许可:是依七哒授权(个人/修改/再分发,署名;不可商用)——alysia 合规,README/页面需署名

### B.1 直接迁入(Electron 全功能,零裁剪)

| 源文件 | 用途 | 搬迁动作 |
|---|---|---|
| `src/renderer/public/models/cyrene/` | 模型本体(model3.json/moc3/4K 纹理/motions×5/expressions×12) | 拷入 `packages/webui/assets/live2d/`;纹理预压缩 |
| `src/renderer/live2d/manager.ts` | Live2DManager(加载/缩放/动作播放;baseScale 固定基准窗 400×500) | Vue 封装 |
| `src/renderer/live2d/mouth-sync.ts` | MouthSyncController(时长驱动口型,180ms tick + 随机抖动,上限 5min) | 照抄;TTS 接线预留 |
| `src/renderer/live2d/speaking-motion.ts` | SpeakingMotionController(说话时荡秋千,5s 切换/1.2s 保持) | 照抄 |
| `src/renderer/live2d/interaction.ts` | InteractionController(点击命中区→动作,位移阈值 5px) | 照抄 |
| `src/renderer/live2d/expression-reset.ts` | ExpressionResetController(3min 自动回正;**默认表情名源码乱码,改"表情回正"**) | 照抄+修复 |
| `src/renderer/live2d/focus.ts` | MouseFocusController(注视跟踪 + 全局光标轮询 IPC) | **照抄(含 IPC,不再裁剪)** |
| `src/renderer/live2d/click-through.ts` | 点击穿透(像素采样 α<10 + setIgnoreMouseEvents forward) | 照抄 |
| `src/renderer/main.ts` 拖窗段 | 拖窗(capturePage 拖影消除 + ticker 暂停 + opacity 0.99) | 照抄 |
| `src/shared/live2d-actions.ts` | LIVE2D_ACTIONS 动作目录(10 项)+ findAction | 照抄 |

### B.2 借鉴模式(不搬代码,搬设计)

- **动作工具链**:`play_live2d_action`(LLM 中文别名 → findAction 校验 → 解析 target → 执行,渲染层不见原始别名)→ alysia 聊天工具注册
- **口型时长驱动**:不解析音频波形,audio.onended + 真实时长 → 定时器模拟张嘴 → 零成本
- **情绪映射不硬编码**:LLM 自主决定动作(提示词带动作目录),不做"情绪→表情"自动表
- **tokens.css 设计系统**:粉紫深色 token 集(品牌粉 #ec4899 + 紫渐变 + 玻璃拟态 + 发光阴影 + 文字层级)→ 与星穹紫金主题融合

### B.3 主进程窗口件(Electron 主进程照抄)

| 源文件 | 用途 |
|---|---|
| `src/main/index.ts` 桌宠窗口段(2465-2493) | BrowserWindow:400×500/transparent/frame:false/skipTaskbar/hasShadow:false |
| 置顶(1225) | `setAlwaysOnTop(alwaysOnTop, "screen-saver")` 压过全屏 |
| 点击穿透 IPC(3069) | `setIgnoreMouseEvents(!interactive, {forward:true})` |
| 拖影消除(3108-3117) | 拖动时 `setOpacity(0.99)` 强制 DWM alpha 路径 |
| `src/main/pet-window-movement.ts` | PetWindowMoveController(rAF 节流 16ms/离屏校验/位置持久化) |
| `applyPetZoom`(1236) | setSize + PET_ZOOM 广播 |
| `src/preload/index.ts` live2d 命名空间 | contextBridge:`cyrene` / `live2dSpeech` / `live2dAction` |
| `src/shared/ipc-channels.ts` | `window:*` / `pet:*` / `live2d:*` 通道常量 |

**opener 主动开口气泡**:可选,一期不做(主动消息已有推送通道,气泡是桌宠专属增强)。

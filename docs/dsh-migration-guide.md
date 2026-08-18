# Alysia → dsh 迁移参考文档

> 日期:2026-08-19 | 用途:在 DeepSeek Harness(dsh)上复刻/迁移 alysia 开发的完整参考
> 源项目:`E:\workSpace\alysiaAgent`(monorepo,四包:core/server/webui/desktop)
> 本文档目的:让接手者不重复踩坑——列出架构、机制、**全部已知坑位**与修复,以及迁移对接建议。

---

## 1. 项目速览

**Alysia** = QQ 陪伴机器人(昔涟人格,崩铁黄金裔),双模式:
- **聊天模式**:QQ 官方适配器 + 记忆系统 + AI 主动生活(LifeService)+ 主动消息(ProactiveService)
- **编程模式**:桌面端(Electron)codeMode,携带聊天积累的人格/记忆(对标 Claude Code/dsh)

技术栈:TypeScript monorepo(pnpm workspace)+ better-sqlite3(WAL)+ LanceDB(向量)+ Fastify(WebUI)+ Vue 3(Electron SPA)+ pixi-live2d-display(Live2D)。

## 2. 架构总览

```
packages/
├── core/     # 核心:记忆系统(8 store/3 engine/3 processor)+ Pipeline(7 stages)+
│             #   Provider(DeepSeek+智谱双 provider)+ AgentRunner(ReAct 循环)+ 工具注册表
├── server/   # Fastify(WebUI API 6185)+ QQ 官方适配器(WebSocket)+ LifeService +
│             #   ProactiveService + VisionBridge(图片描述)+ bootstrap 装配
├── webui/    # Vue 3 SPA(hash 路由)+ 管理面板 10 页 + 聊天视图 + Live2D 组件 + pet 桌宠页
└── desktop/  # Electron 壳:主进程 fork 后端子进程 + 主窗口 + 透明桌宠窗口 + preload
```

**关键设计**:服务端是权威,WebUI 是投影(抄 dsh 思路:unary RPC + 下行事件流)。聊天消息走完整 pipeline(记忆/人格/生活全链路),不是独立 agent 循环。

## 3. 核心机制速记

| 机制 | 说明 |
|---|---|
| Pipeline | 7 stages:PII → MemoryIngest → **Coalescer**(输入合并/打断)→ Worldbook → MemoryRetrieval → LLMAgent → Respond |
| Coalescer | 私聊窗口合并 + 新消息打断在飞;打断结果**永不发送**;合并只并请求不并结果;`cancel_thinking` 取消思考提示 |
| EventBus | 私聊 fire-and-forget(并发)/群聊串行;`put(event, {priority})` 插队 |
| AgentRunner | ReAct 循环(max 10 步);abort 契约(循环开头/err 分支/终检三检查点);`runStream(..., onChunk)` 流式出口 |
| Provider | OpenAI 兼容双 provider;60s `Promise.race` 超时(AbortController 无法中断 DNS 阶段);`streamWithFallback`(首 chunk 前才切 fallback) |
| 记忆系统 | 8 store + 3 processor(Realtime/SessionEnd/Cron)+ 记忆旋钮(decay/importance/recency/confirmation/retention)+ PII + 隐私模式 |
| 内容自进化 | 昔涟自写 worldbook/life 模板:机械预检(查重/长度)+ LLM 校验器(异常降级拒写);对话内删除仅响应指令 |
| WebUI 聊天 | SSE 流式(connected/chunk{kind:text|reasoning}/done/aborted 帧);reasoning 进"思考条"(转圈+默认隐藏可展开);会话 id `webui:private:<uuid>` |
| 桌面端 | Electron fork 后端子进程(纯 Node,规避 ABI);主窗口=退出全部;桌宠窗口透明置顶 |

## 4. 踩坑清单(按域分类,每条含根因 + 修复)

### 4.1 服务端 / Web 托管

1. **Fastify v5 移除了 `'/*'` 通配路由**(v4 语法直接失效,`Route GET:/ not found`)
   → 用 `app.setNotFoundHandler()` 兜底静态文件,排除 `/api/` 前缀。
2. **静态托管路径三级上溯**:`dist/webui/server.js` 上两级是 `packages/server` 不是 `packages`
   → `resolve(dirname(import.meta.url), '../../../webui/dist')`。路径错 → `existsSync` 为 false → 静态路由静默不注册(最隐蔽的坑,dev 不报错)。
3. **静态托管只 serve index.html**:assets/pet.html/模型全 404,SPA 白屏
   → 整个 dist 目录按扩展名 MIME 表全量托管,未知路径回退 index.html(hash 路由)。
4. **表情包路径 `/data/stickers/x.png`(容器绝对路径)在 Windows 解析到盘根读不到**
   → 多候选解析:`原路径 → 去前导 / → resolve(serverDataDir, stickers, basename)`。
5. **表情包 API 返回裸数组,前端按 `{stickers}` 解构 → undefined → 显示空态**
   → 统一响应信封 `{ stickers: [...] }`(所有列表端点保持一致)。
6. **表情包 db 条目(20)比实际文件(13)多**(角色包导入的条目缺文件)
   → 列表过滤文件真实存在的条目,缺失记 WARN 日志(含名字,便于补文件)。
7. **`importRole` 的 `DELETE WHERE role=?` 误删同 role 的 seed/自写条目**
   → 66 条文本世界书被表情包角色包清空(启动顺序:seed 先,角色包后,后者删前者)
   → 改为只删"本次包生成的 id 集合"(`wb_<role>_<hash>` 预计算)。
8. **sessionId 前缀累积污染**:`webui:private:webui:private:...`(早期版本 replace 只清一层,
   前端 localStorage 存带前缀 id,每次发送 +1 层,实测 4 层)
   → 统一 `cleanSid` 剥全部前缀;前端也清洗;`unifiedMsgOrigin` 只由 `MessageSession.toString` 拼一层。
9. **LLM 超时**:AbortController 无法中断 undici fetch 的 DNS/连接阶段(实测挂 566s)
   → 60s `Promise.race([fetch, timeoutPromise])`,挂起 fetch 的 rejection 用 `.catch(()=>{})` 吞掉;
   流式读取循环也 race(共用 deadline,中途断流准时超时)。
10. **DeepSeek reasoning 模型**:`reasoning_content` 消耗输出预算,`max_tokens` 必须给大(8192),
    否则 `content` 为空(cleanup 脚本 1024 不够,改 8192)。
11. **流式 fallback 只在首 chunk 前切换**:中途失败重试会丢前半回复 → 首 chunk 偷看模式,
    已出 chunk 后失败直接终止。

### 4.2 桌面端(Electron)

12. **原生模块 ABI 不匹配**:`ERR_DLOPEN_FAILED`(better-sqlite3 为 Node 编译,Electron 加载失败)
    → **不要 electron-rebuild**(会破坏 server 的 Node 运行,同 node_modules 只有一个编译产物)
    → 子进程架构:Electron 主进程 `fork` 后端(server dist),`execPath: process.env.npm_node_execPath ?? 'node'`
      + env `ELECTRON_RUN_AS_NODE: '1'`(默认 fork 用 Electron 可执行文件,ABI 还是错)。
13. **Electron 进程残留叠罗汉**:每次重启只杀后端(6185 占用者),旧 Electron 应用一直挂着,
    用户看到"小人关不掉"、多个窗口叠着(实测残留 4 组 40 个进程)
    → 重启流程:按 CommandLine 匹配 `*alysiaAgent*` 过滤杀 electron+node(不误伤 VSCode 等其他 Electron),再启动。
14. **主窗口关闭 = 退出全部**:`window-all-closed` 要求所有窗口关闭才退出,主窗口关了桌宠还挂着
    → 主窗口 `closed` 事件里 `app.quit()`(连带后端子进程回收)。
15. **preload 没被复制进 dist**:tsc 不编译 .cjs,preload 路径指向不存在的文件,窗口控制全部失效
    → build script 加 `node -e "fs.copyFileSync('src/preload.cjs','dist/preload.cjs')"`。
16. **Vue 模板里不能写 TS 断言**:`@click="(window as any).appWindow?.minimize()"` 事件不触发
    → 逻辑全部进 script 方法,模板只调方法名。
17. **拖窗被 hover 拖飞**:pointerup 丢失(移出窗口松开)后拖拽状态残留,纯 hover 的 pointermove
    触发 `moveBy` 增量,窗口持续往屏幕外跑(用户实测)
    → ① `e.buttons & 1` 检查:没按住左键一律不拖并重置状态;② `pointerleave` 兜底重置;
    ③ 不用 `setPointerCapture`(Windows 上 up 丢失会 capture 泄漏拦截点击);
    ④ 4px 位移阈值区分点击/拖动;⑤ IPC 增量 moveBy + 主进程坐标钳制屏幕内。
18. **Electron 默认菜单栏(File/Edit/View)**:`frame: false` + `autoHideMenuBar: true` 去掉;
    窗口按钮(最小化/关闭)走 preload IPC。
19. **-webkit-app-region: drag 不可靠**:改用渲染层 pointer 手动拖 + IPC(见 17)。

### 4.3 Live2D

20. **模型许可**:模型来自 Cyrene-Agent(作者「是依七哒」),授权个人使用/修改/再分发,**署名、不可商用**;README/页面需标注。
21. **纹理 9MB 单张**(4K):首屏加载慢 → 预压缩/懒加载(进聊天视图才 init pixi)。
22. **`baseScale` 必须用固定基准窗**(400×500):用实时窗口尺寸会 zoom 双重计入。
23. **`expression-reset.ts` 源码默认表情名乱码**(拷贝时显示 `�������`):应为 `"表情回正"`。
24. **库版本锁定**:pixi.js 7.3 + pixi-live2d-display 0.5.0-beta + live2dcubismcore.min.js(207KB)
    必须与 Cyrene 完全一致(已验证可跑),cubism core 全局 script 放 index.html 顶部。
25. **点击穿透(像素级)是 Electron 专有**(setIgnoreMouseEvents + 像素采样):浏览器不可用;
    桌宠窗口默认全交互(能拖能点),像素级穿透留二期。

### 4.4 前端 / UI

26. **AI-slop 特征**(用户明确反感):紫色霓虹渐变、发光阴影滥用、纯黑背景、emoji 当图标、渐变文字滥用
    → 图标用真实图标库(lucide-vue-next);渐变收敛;配色按用户指定的 Cyrene 风格
    (粉紫科技:背景紫黑层级 #08070f/#0f0d1f/#181432 + 品牌粉 #ec4899 + 粉紫渐变 + 粉调发光 + 大圆角)。
27. **布局大改前的版本控制**:用户不懂前端,担心越改越糟
    → git tag 回退点:`ui-v1-purple`(初版)→ `ui-v2-gold` → `ui-v3-dock` → `ui-v4-cyrene`(当前),
    任意时刻 `git checkout <tag>` 回退;每完成一个里程碑提交 + 打 tag。
28. **加载态**:管理页"加载中…"文本 → shimmer 骨架组件(LoadingBlock,aria-busy)。
29. **图标系统**:emoji 图标全换 lucide(注意 `Theatre` 在 lucide 不存在,是 `Clapperboard`)。
30. **模板里不能用 TS 断言**(见 16);CSS 动画只用 transform/opacity(impeccable 检测 width 动画告警)。

### 4.5 测试 / 治理 / 运维

31. **E2E 测试需要 .env**:`source .env && npx vitest run tests/memory/e2e/`,否则 2 个失败
    (OPENAI_API_KEY not set)——不是代码问题。
32. **vitest mock 泄漏**:spyOn 跨测试复用 → `beforeEach(() => vi.restoreAllMocks())`;
    `vi.mock` 的类要补齐新方法(加了 runStream 后旧 mock 的类没有 → undefined)。
33. **async generator 的 aborted 分支不 yield**:测试 consumeGenerator 期待挂起,
    aborted 路径直接 return(done:true)——手动消费。
34. **OpenSpec 治理(项目宪法)**:每个行为变更走 propose→apply→archive,禁止"直改不 archive"。
    **本会话教训**:UI 大改 + 一批 bug 修复直接改了没开 change,事后补录
    (`webui-visual-redesign` change 标记"补录")——迁移到 dsh 后建议一开始就建立同样治理。
35. **日志保留 7 天**:`startDailyLogCleanup` 每日清理;用户要求保留足够日志供异常分析,
    清理太频繁会丢信息。
36. **.env 位置**:`packages/server` 目录向上两级(项目根 `.env`);dotenv 从 cwd 解析——
    desktop fork 时 `cwd: serverDir` 保证找到根 .env。
37. **端口约定**:WebUI 6185(生产同源托管);vite dev 5173 代理 /api → 6185。

## 5. 迁移到 dsh 的对接建议

| 层 | 建议 |
|---|---|
| 记忆系统 | **核心资产,重写成本最高**:8 store + 旋钮 + 自进化校验器——建议以 dsh 插件形态移植(纯逻辑,无 UI 依赖) |
| Pipeline/Coalescer | dsh 有自己的 agent 循环(turn/step/tool-call),**用 dsh 的**,Coalescer 的"合并只并请求不并结果"语义要保留(QQ 场景特有) |
| Provider 层 | dsh 已有 LlmAdapter(DeepSeek 适配器 + SSE + retry),**直接用**;把 sampling 槽位映射到 dsh 配置 |
| WebUI | dsh 有完整前端(slot 插件体系)——**复用 dsh 壳**,把 alysia 管理页做成插件注册进 slot;聊天流式事件映射 dsh 的 conversation 事件 |
| Live2D | 渲染层 7 文件是纯浏览器代码,**直接搬**(照抄清单见 §3),Electron 窗口件照抄 Cyrene |
| QQ 适配器 | dsh 无 IM 适配器——**全新插件**(WebSocket + 消息→session 事件映射 + 表情包协议) |
| 内容自进化 | 工具注册走 dsh `ctx.tools.register`;校验器逻辑照搬 |

**迁移顺序建议**:记忆系统插件 → QQ 适配器插件 → 生活/主动服务插件 → WebUI 页面插件 → Live2D。

## 6. 运行手册(当前形态)

```bash
# 依赖
pnpm install

# 服务端(QQ 机器人 + WebUI)
cd packages/server && pnpm dev        # 6185

# WebUI 纯前端 dev(代理到 6185)
cd packages/webui && pnpm dev         # 5173

# 桌面端(Electron:主窗口 + 桌宠小人)
cd packages/desktop && pnpm dev

# 测试
cd packages/core && npx vitest run --exclude='tests/memory/e2e/*'
cd packages/server && npx vitest run

# 版本回退
git checkout ui-v4-cyrene             # 或 ui-v1-purple(初版)
```

## 7. 已知待办(迁移时一并考虑)

- `play_live2d_action` 工具(LLM 中文别名 → 小人动作)——记在 memory:alysia-todo-live2d-states
- 桌宠窗口像素级点击穿透(Electron 专有,二期)
- 编程模式(对照 dsh 功能面,走扩展点)
- importance 计算接入(使 importance_threshold 旋钮生效)

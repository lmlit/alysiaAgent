# alysiaAgent 代码审查修复计划（2026-08-29）

> 本次 CR：4 个方向并行精读（memory / pipeline+agent / server / webui+dsh+desktop），共约 25K 行。
> 关键发现已抽验属实（群隔离 SQL、悬空 import、abort 未接线、QQ 错误码检查）。
> 由业务负责人逐项确认并修复，修复时按 OpenSpec 流程开 change。

## 修复状态总览

| 优先级 | 数量 | 状态 | 说明 |
|--------|------|------|------|
| P0 严重 | 4 | ☐ | 隐私/安全/核心行为问题，优先修 |
| P1 高 | 10 | ☐ | 明显 bug 或活性缺陷 |
| P2 中 | 12 | ☐ | 健壮性/一致性/潜在风险 |
| P3 低 | 12 | ☐ | 死代码/清理/小优化 |
| **总计** | **38** | — | 建议先修 P0，再按子系统批量处理 |

---

## P0 — 严重（建议本周处理）

### 1. 群聊会话隔离失效，跨群摘要泄漏
- **位置**: `packages/core/src/memory/stores/ConversationStore.ts:59-61`（group 分支），`:63-64`（private 分支）
- **问题**: group 分支用 `sessionId.split(':group:')[0]` 只取平台前缀，再 `LIKE '平台:group:%'` 匹配——同平台**所有群**的对话摘要都会被捞出来。群 A 的聊天内容会注入群 B 的 prompt。private 分支 `LIKE '%:private:%'` 同理，跨平台混入所有私聊摘要。
- **业务影响**: 这是隐私问题——不同群/私聊的人会看到彼此聊过的事，且行为不可预测（取决于哪个群最近活跃）。
- **建议**: 按完整会话前缀精确匹配（`LIKE '平台:group:群ID%'`），private 分支也按平台前缀限定。

### 2. WebUI 管理面板零鉴权，绑定 0.0.0.0
- **位置**: `packages/server/src/webui/server.ts:39-301`、`packages/server/src/bootstrap.ts:260`
- **问题**: 全部 `/api/*` 路由没有鉴权且监听所有网卡。局域网任意设备可读取全部画像/人格/会话消息/Token 用量，可删除知识库/世界书/生活模板、切换角色、开关隐私模式，并经 `/api/chat/stream` 无限消耗 LLM 额度。
- **业务影响**: 你的 AI 人格数据和聊天记录裸奔在局域网；任何人都能删数据、烧你 DeepSeek 的 token 账单。
- **建议**: 加 Bearer token 鉴权（config.yml 或环境变量下发）；非桌面模式默认绑 127.0.0.1。

### 3. Coalescer 打断/合并存在三处竞态
- **位置**: `packages/core/src/pipeline/stages/coalescer.ts:82-95`、`:138-143`；`pipeline/stages/llm-agent.ts:155`
- **问题**: ① abort 后 controller 立即从注册表删除，"打断→flush 完成"窗口内到达的新消息被当独立消息重新生成；② 在飞判定依赖 llm-agent 阶段才创建的 controller，中间隔着几百 ms 向量检索，并发消息双双放行；③ `flushBucket` 在 await 图片描述前就删桶，desc 失败则整批消息丢失。
- **业务影响**: 用户快速连发消息时出现重复回复、回复乱序，且每条都白烧一次完整 LLM 调用（成本翻倍）。
- **建议**: 在飞标记提前到 coalescer 阶段同步登记；abort 后保留 buffering 状态直到 flush 完成；desc promise 包 `catch(() => null)`。

### 4. "删除"不删向量 + 5 处空 catch 静默吞错
- **位置**: `packages/core/src/memory/MemoryManager.ts:264-271`（deleteSession）、`:1098-1100`（deleteKnowledgeDoc）、`stores/LanceDBStore.ts:135-143`；静默吞错：`processors/SessionEndProcessor.ts:150-152`、`MemoryManager.ts:767-774`/`:511`/`:1073`、`processors/RealtimeProcessor.ts:93-95`
- **问题**: ① WebUI"彻底删除"的会话/知识文档不清理向量，[相关记忆] 仍会召回已删内容；② LLM 摘要失败静默写垃圾摘要入库、embed 失败全空 catch，无任何日志——故障期间系统"看起来正常"地写坏数据。
- **业务影响**: 用户删了的东西还在被想起（隐私 + 体验）；API 故障时无感知，事后排查无从下手。
- **建议**: 删除/归档同步调 `vectorStore.delete()`；每个 catch 至少 `logger.warn(err + 上下文)`（遵守项目"不静默吞错"约定）。

---

## P1 — 高（建议尽快）

### Server / QQ 适配器

### 5. QQ 官方发送不检查业务错误码
- **位置**: `packages/server/src/adapters/qq-official.ts:772-781`（sendSegmented）、`:586-592`（群媒体）
- **问题**: QQ 官方 API 业务错误（被动窗口过期 40011000、限流等）返回 HTTP 200 + body.code≠0，这里只查 `resp.ok`（永远 true）→ 段继续发、调用方以为成功。同文件 `postMessage`（:728）知道查 code，标准不一致。
- **业务影响**: 被动窗口过期时用户收不到回复，系统却无任何告警——"看着正常实则失联"。
- **建议**: 解析响应体，`code === 0` 才算成功；失败中断并打 warn（含 body）。这正是踩过的 40011000 坑。

### 6. LifeService 活性缺陷：任一异常即永久停摆
- **位置**: `packages/server/src/life.ts:196`（`if (!evt) return;`）、`:104`（tick 异常只打日志）、`adapters/qq-official.ts:720-735`（postMessage 无超时）
- **问题**: 主动生活靠**单个 setTimeout** 驱动。① LLM 失败且模板池空时 `evt === null` 直接 return 不重排；② tick 内未捕获异常只记日志不重排；③ postMessage 的 fetch 无超时，网络挂起 tick 永不结束。
- **业务影响**: 三种情况任一发生，"轻月"的主动生活系统永久停摆直到重启，且完全静默。
- **建议**: `!evt` 时仍 `scheduleNextEvent()`（或指数退避）；tick 包 try/finally 保证重排；发送加超时（参考 uploadImage 20s 先例）。

### 7. QQ WebSocket 重连三缺陷
- **位置**: `packages/server/src/adapters/qq-official.ts:436-438`（op 7 只打日志）、`:446`（seq 不重置）、`:360-401`（frameBuffer 实例级共享）
- **问题**: ① op 7（服务端要求重连）不动作；② 重连后 `seq` 携带旧会话序列号；③ `frameBuffer` 跨连接复用，旧连接残留半帧字节与新连接帧拼接 → JSON 解析错位被 `catch {}` 吞掉。
- **业务影响**: 断线重连后首批消息静默丢失，心跳可能被判定无效。
- **建议**: op 7 时 destroy socket 走重连流程；收到 op 10/Ready 时 `seq = null`；`connectWss` 里每连接独立 `frameBuffer`。

### 8. Token 刷新永不失效（NaN 陷阱）
- **位置**: `packages/server/src/adapters/qq-official.ts:180-199`
- **问题**: `refreshToken` 不查 `resp.ok`、不记录响应体；`expires_in` 缺失时 `tokenExpiry = NaN`，`Date.now() > NaN` 恒 false → access_token 永远不刷新，带过期 token 静默跑。
- **业务影响**: 一段时间后所有发送全部失败，且无从排查。
- **建议**: 检查 `resp.ok` 与 `data.code`，失败打 warn 含 body；`expires_in` 非法时置 `tokenExpiry = 0` 强制下次刷新。

### 9. WebUI 会话的 reminder 静默消失
- **位置**: `packages/server/src/bootstrap.ts:196-218`
- **问题**: `notifyFn` 对非 QQ 私聊会话（即 WebUI 里设的提醒）只打一行 info 日志、返回 `true`——被当"已处理"，用户永远收不到。
- **业务影响**: WebUI 用户设了提醒但毫无提示，功能形同虚设。
- **建议**: 二选一：WebUI 挂到点提示（轮询/SSE），或设置时明确拒绝并返回错误。

### 10. 主动消息无全局日配额
- **位置**: `packages/server/src/proactive.ts:353-409` + `life.ts:231-247`
- **问题**: 问候 3 条/天 + 节日 + 关怀 + Life 聊天 5 条/天各管各的，互不知晓，合计最多约 10 条/天主动消息。
- **业务影响**: 持续高频主动消息有触发 QQ 风控/封号风险。
- **建议**: adapter 或 bootstrap 层加统一日配额（全平台合计 ≤N/天），所有主动路径共用。

### Core

### 11. 超时命中后不 abort 底层请求
- **位置**: `packages/core/src/provider/openai.ts:72, 186`
- **问题**: 60s 超时 race 命中后从不调 `controller.abort()`，已建立的连接保持打开，后端继续生成烧 token（实测可到 566s）；流式路径 `reader.read()` 同样未取消。
- **业务影响**: 一次卡顿可能白烧整次生成的 token 费用。
- **建议**: 超时分支先 `controller.abort()` 再返回；流式 catch 中 `await response.body?.cancel()`。

### 12. 长会话摘要永远缺最新消息
- **位置**: `packages/core/src/memory/stores/EventStore.ts:62-69`
- **问题**: `getBySession` 无 limit 时硬编码 `LIMIT 1000` 且 `ORDER BY created_at ASC`——会话超 1000 条时摘要只用最旧 1000 条，**最新消息不进摘要**。
- **业务影响**: 高频 QQ 群/私聊的长会话，人格记忆越来越陈旧失真。
- **建议**: 去 cap 或按窗口查询；SessionEndProcessor 按 since 游标分批取。

### WebUI / dsh

### 13. "停止"按钮是假的
- **位置**: `packages/webui/src/views/ChatView.vue:206` + `packages/webui/src/api/client.ts:35-45`
- **问题**: 创建了 `abortCtrl` 但 `streamChat` 的 fetch 从不接收 signal——点"停止"后流在后台继续跑，文本继续往旧气泡追加，此时可再发新消息造成双流交错。已验证。
- **业务影响**: 用户无法打断 LLM 输出，还会出现两条回复混着长。
- **建议**: `streamChat` 增加 `signal` 参数传给 fetch；stop 后忽略后续 frame；组件卸载时也 abort。

### 14. dsh-console 反代不转发请求体 + XSS
- **位置**: `packages/dsh-console/src/proxy.ts:38`；`console-ui.ts:251-267`
- **问题**: ① 反代 fetch 从不转发请求体，且转发 forbidden header `content-length`——任何带体 POST 静默丢体或直接 502；② `row()` 用 `innerHTML` 拼 LLM 生成的画像数据（name/tone 等），未转义 → XSS。
- **业务影响**: 控制台面板可被注入脚本；未来任何带体 API 经反代必挂。
- **建议**: 转发 `req` body（去掉 content-length 转发）；用 `textContent` 或 `esc()` 转义后拼接。

---

## P2 — 中

### 15. 记忆系统 LLM 调用无超时
- **位置**: `packages/core/src/index.ts:154-172`
- **问题**: `llmService.complete` 无超时无 abort；embed 的 8s AbortController 对 DNS 挂起阶段无效（undici 行为），实际超时会远超 8s。
- **建议**: complete 加 60s race；embed 用 `Promise.race` 保证准时返回并吞掉挂起 rejection。

### 16. vision bridge 无超时 + 本地文件读取外泄
- **位置**: `packages/core/src/vision/bridge.ts:46, 98, 92-95`
- **问题**: GLM-4V 调用和图片下载 fetch 无超时 → 整条 pipeline（含首条消息）卡死；本地路径直接 `readFileSync` 转 base64 发给 GLM，任意本地文件可被读取外泄。
- **建议**: 两处加 `AbortSignal.timeout()`；本地路径限定在允许的缓存目录；远程 URL 禁止内网/环回地址。

### 17. 群聊事件全局串行
- **位置**: `packages/core/src/eventbus/EventBus.ts:87-91`
- **问题**: 群聊事件在单 dispatch 循环里被 await 串行化——一个群的 LLM 生成（最长 60s+）阻塞所有其他群。
- **业务影响**: 一个群聊卡住，全部群都响应变慢。
- **建议**: 按 session 维度串行（每会话一条执行链），或群内串行 + 群间并发。

### 18. 原始错误文本发给用户
- **位置**: `packages/core/src/agent/runner.ts:89-91, 299-304`
- **问题**: provider 错误文本（`API error 429`、`Request timed out`）原样当回复发出；流式中途失败时若已有部分文本，静默用半截文本当完整回复。
- **业务影响**: 用户看到技术报错；回复残缺无感知。
- **建议**: 固定委婉话术（"刚才走神了，再说一遍好吗"），细节只进日志；失败时发明确 error 标记。

### 19. 角色激活可产生双激活行
- **位置**: `packages/core/src/memory/stores/PersonaStore.ts:87-95, 44-46`
- **问题**: `upsertRole` 激活时只置位不清其他行 → 双激活行；`get()` `WHERE is_active=1 LIMIT 1` 无 ORDER BY，返回哪一行不确定。
- **建议**: 同事务先 `UPDATE ... SET is_active=0 WHERE is_active=1`；get() 加 `ORDER BY id`。

### 20. 切角色后实时 worldbook 命中错角色
- **位置**: `packages/core/src/memory/processors/RealtimeProcessor.ts:41`
- **问题**: `worldbookMatcher.match(text, mode)` 不传 role 走默认 'alysia'，而 read() 路径传 activeRole——切换角色后实时匹配和 hit_count 落在错误角色上。
- **建议**: RealtimeProcessor 注入当前激活角色。

### 21. importKnowledge 串行 embed + 无事务
- **位置**: `packages/core/src/memory/MemoryManager.ts:1028-1075`
- **问题**: 逐 chunk 串行 await embed（大文档线性耗时）；doc 先插入、chunk 中途失败留半成品无回滚；失败无日志。
- **建议**: 并发上限（如 5）+ 失败日志 + 事务包裹。

### 22. 关闭流程不清理子系统
- **位置**: `packages/server/src/bootstrap.ts:249-254`
- **问题**: 只 `clearInterval` + `core.stop()`，qq/onebot/telegram/Life/Proactive 的 stop 全没调——Proactive 去重状态丢最后窗口，重启后当天问候可能重复发。
- **建议**: 统一遍历子系统调 stop()/terminate()；或 stateFile 立即写盘。

### 23. 状态文件非原子写
- **位置**: `packages/server/src/life.ts:126-134`、`proactive.ts:157-188`
- **问题**: `writeFileSync` 先截断后写，崩溃/断电留损坏 JSON → loadState 静默当 fresh start → 去重失效，重复推送。
- **建议**: 写临时文件 + `renameSync`（同盘原子）。

### 24. 向量检索空结果不走文本回退
- **位置**: `packages/core/src/memory/MemoryManager.ts:751-774`
- **问题**: vectorStore 启用但检索全空（新库/无命中）时，SQLite 里明明有可检索文本却返回空 [相关记忆]（注释只处理了 vectorStore === null 的情况）。
- **建议**: 四条向量搜索全空时回退 `searchByText`。

### 25. applyCorrectionFastPath 绕过 PII 过滤
- **位置**: `packages/core/src/memory/MemoryManager.ts:221-241`
- **问题**: 原始 text 直接进 LLM prompt，`evidence: signal.rawText` 原文写 profile 库，全程不经 filterPII（当前无生产调用方，潜伏隐患）。
- **建议**: 入口处 filterPII 后再用。

### 26. 客户端断开不中止后台 pipeline
- **位置**: `packages/server/src/webui/chat.ts:90-144`
- **问题**: 断开/90s 超时只 end() 响应，不 abort 后台 pipeline——LLM 继续生成、记忆继续回写；用户刷新重发后同消息处理两次（双份记忆）。`res.write` 到已销毁 socket 可能抛错无人处理。
- **建议**: `req.raw.on('close')` → AbortSignal；按 messageId 幂等去重。

---

## P3 — 低（死代码/清理/小优化）

### 27. webui 悬空 import（构建必失败）
- **位置**: `packages/webui/src/live2d/manager.ts:4` — `import ... from "../../shared/live2d-actions"`，该目录不存在（已抽验），定义在同目录 `actions.ts`。当前 `vite build` 必失败，dist 是过期产物。**建议先修这条才能构建验证其他修复。**
- **建议**: 改为 `from './actions'`。

### 28. 表情回正功能从未生效
- **位置**: `packages/webui/src/live2d/expression-reset.ts:19` — 默认表情名是乱码 `"�������"`（编码损坏），每 3 分钟定时回正必然失败。补回正确表情名。

### 29. 归档会话仍被检索
- **位置**: `packages/core/src/memory/stores/EventStore.ts:98-123, 133-161`（`getMessagesBySession`/`getRecentBySession` 无 `archived=0` 过滤）；ConversationStore 同理。
- **建议**: 查询统一加 `AND archived = 0`。

### 30. listRoles N+1
- **位置**: `packages/core/src/memory/MemoryManager.ts:1144-1150` — 每角色一条 COUNT 查询，WebUI 角色列表每次全量循环。改 `GROUP BY role` 单查询。

### 31. 死代码清理
- **位置**: `MemoryManager.ts:826-828`（assemble @deprecated）、`ProfileExtractor.mergeFacts`、`ProfileStore.getFacts`、`EventStore.countBySession`、`WorldbookStore.updateEntry`、`confirmPersona` 的 `persona_change` 分支（永假）、`qq-official.ts` 死代码（`:303-310` startHeartbeat 从未调用、`:471-473`/`:536-542` 计算结果未用）、`webui/src/live2d/focus.ts` + `speaking-motion.ts`（无导入方且引用不存在的 `window.cyrene`）。
- **建议**: 删除或标记 TODO。

### 32. 命令返回空串被当普通消息
- **位置**: `packages/core/src/commands/registry.ts:23-32` — handler 返回 `''` 时 `if (cmdResult)` 为 false，命令被当成普通消息继续走 LLM（副作用已执行还多烧一次生成）。改 `cmdResult !== null` 判定。

### 33. reminder 时间解析脆弱
- **位置**: `packages/core/src/tools/reminder.ts:123-131` — `endsWith('min')` 大小写敏感，`parseInt("1.5h")=1`。改正则 `^(\d+(?:\.\d+)?)(min|h|d)$`。

### 34. 其他小项
- `MemoryManager.ts:359-368` `_worldviewBlock` 永久缓存，persona 文件运行期改动不生效（记 mtime 或设过期）。
- `MemoryManager.ts:1135-1141` findSticker `LIKE '%name%'` 未转义 `%`/`_`。
- `MemoryManager.ts:951-955, 998-1000` snapshot 直接 `JSON.parse` 无保护 → JSON 损坏时 WebUI 接口 500 无日志（复用 PromptAssembler 的 safeParseJSON）。
- `MemoryManager.ts:57` `TOKEN_STATS_FILE` 相对 cwd，Docker 下静默失败；tokenStats Map 无界增长；saveTimer 无 dispose。
- `MemoryManager.ts:1032-1036` importKnowledge 去重 hash 含 title，同内容改标题会重复导入。
- `CronProcessor.ts:66-70` `JSON.parse(profile.facts)` 在 try 外，facts 损坏时整个 cron 中止。解析移入 try。
- `llm-agent.ts:86` `compactPersona` 按分隔符硬切 4 段无 token 预算，第 5 段起内容静默丢弃。
- `tools/worldbook.ts:18-23` 索引 id 取 `keys[0]`，触发词首词相同的条目互相覆盖丢失。
- `pipeline/context.ts:4-31` 配置类型重复定义 + 占位注释残留生产路径。
- `provider/openai.ts:42,155` abort listener `{ once: true }` 从不移除，长会话累积。
- `proactive.ts:376` 关怀扫描 `listSessions(20)` 截断，>20 个活跃会话时 owner 关怀永不再发。
- `chat 流 90s 超时与长回复冲突`（见 #26）。
- `qq-official.ts:404,457,480,564` 每条消息 4+ 行 info 日志刷屏，常规降 debug。
- `ChatView.vue:161` 会话高亮因 id 前缀不一致永不生效；`:323` v-for key 用 content 会重复。
- `PersonaView.vue:40,73` retention_bias 描述"-1~+1"但滑块 min=0 max=1，控件与文案不一致。
- `dsh-adapter/src/index.ts:59-85` `latestUserMessage` 只写不读的活死代码。
- `index.html:10` live2dcubismcore.min.js 全局预载，所有页面都下载 MB 级脚本，改动态注入。
- `desktop/src/main.ts:31-35` 后端子进程退出不重启不提示。

---

## 建议修复顺序

1. **P0-1 群隔离 SQL** → **P0-2 WebUI 鉴权** → **P0-4 删除清向量 + 空 catch 补日志**（隐私/安全三件套，改动小收益大）
2. **P1-5~10** Server 活性与 QQ 适配器（先 P1-5 错误码、P1-6 单定时器、P1-7 重连）
3. **P1-11/12 + P2-15/16** Core 超时与可观测性
4. **P1-13 + P3-27** WebUI（先修悬空 import 恢复构建，再验证其他修复）
5. 其余按子系统批量处理

> 修复时遵守项目约定：外部交互必须检查响应体并打日志（不静默吞错）；每个行为变更走 OpenSpec change 流程。

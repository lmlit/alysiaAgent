# Change Proposal: webui-chat-endpoints

## 元信息

- **日期**: 2026-08-15
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `alysia-architecture`（LLMAgentStage 流式分支 + PipelineExtras on_chunk/on_done）

## 动机（为什么做）

WebUI(PRD M0)聊天视图需要服务端入口:**消息进现有 pipeline(记忆/人格/生活全链路)**
并拿到回复。llm-streaming-pipeline 已提供 runner 流式出口,但 pipeline 层(LLMAgentStage)
仍只有非流式 run();服务端没有 chat 端点。QQ 通道不受影响。

## 需求（做什么）

- [ ] core: PipelineExtras 加 `on_chunk`(流式块回调)与 `on_done`(chain|null 结束通知)
- [ ] core: LLMAgentStage 检测 `on_chunk` → 走 runStream 流式分支(文本/reasoning 逐块回调);aborted 分支(3 处)调 `on_done(null)`——SSE 端点在被打断时能关闭
- [ ] server: `POST /api/chat/prompt` — 注入消息进 pipeline(MessageEvent + eventBus.put),send 回调收集完整回复,90s 超时
- [ ] server: `POST /api/chat/stream` — 同上,SSE 流式(on_chunk 逐块写帧 + on_done 收尾),非 2xx 错误用 `{ok:false}` 信封
- [ ] server: `GET /api/sessions/:id/messages` — 会话消息历史分页(limit + before 游标),按消息边界
- [ ] server: `GET /api/chat/pending` — 会话是否有在途回复(Coalescer isInFlight)
- [ ] MemoryManager: 新增 `getSessionMessages(sessionId, limit, before?)`(分页游标,Web-API 契约)
- [ ] Web-API-Design.md 登记新方法/端点

## 设计决策（怎么做，含备选与取舍）

1. **WebUI 会话命名**:`webui::private:<uuid>`(平台前缀 webui,与 QQ/Telegram 隔离;含
   `:private:` 自动归入私聊记忆隔离)。会话列表 = listSessions 前端过滤 webui: 前缀。
2. **走完整 pipeline**:消息构造 MessageEvent → eventBus.put ——与 QQ 完全同构,Coalescer
   合并/打断/思考取消/记忆回写/生活注入全部生效(PRD 硬约束)。备选(直接调 runner 绕过
   pipeline)被否——丢失记忆/人格/合并语义,聊天体验降级。
3. **on_done 通知**:aborted 分支(打断/竞态)不经过 RespondStage(不 yield)→ send 不会被调,
   SSE 会挂起。新增 `on_done(chain|null)` extra:正常 = RespondStage 的 send 回调内触发;
   打断 = LLMAgentStage aborted 分支直接触发,SSE 端收到 null 即关闭。
4. **流式 + 合并**:WebUI 消息也进 Coalescer(连发合并)——回复被合并中断时 SSE 收到
   on_done(null),前端显示"已合并,新回复即将到来"。
5. **pending 端点**:Coalescer AbortRegistry.isInFlight 查询——页面刷新恢复"回复中"状态。
6. **历史分页**:events 表按 created_at 游标(before ISO)+ limit,向下翻页;首页取最新。
   getRecentMessages 只有 since 无游标 → 新增 getSessionMessages。

## 对账方向确认

- [ ] 是否与现有 spec 冲突？—— alysia-architecture 无 chat 端点/on_chunk 覆盖 → 新增
- [ ] 涉及 Web API？—— 是。MemoryManager.getSessionMessages 登记 Web-API-Design.md §2/§3

## 测试计划

- core:llm-agent 流式分支(on_chunk 透传/aborted 调 on_done(null)/非流式路径不变)
- server:chat/prompt 注入成功/超时;chat/stream SSE 帧顺序(text/reasoning/end/abort 帧);
  messages 分页游标;pending 查询
- 回归:QQ 主路径全量

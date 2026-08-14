# Spec 变更: alysia-architecture §3.3/§4（WebUI chat 端点 + 流式分支）

> apply 用——变更行用 `+` 标记。未列行与旧 spec 一致。
> 影响主 spec：`openspec/specs/alysia-architecture/spec.md`

### PipelineExtras 扩展（2026-08-15，change: webui-chat-endpoints）

+ - `on_chunk?: (chunk: { kind: 'text' | 'reasoning'; text: string }) => void`
+   —— 流式块回调（WebUI SSE 注入；LLMAgentStage 检测到即走 runStream 分支）
+ - `on_done?: (chain: MessageChain | null) => void`
+   —— 结束通知：正常 = RespondStage send 回调内触发；打断（aborted 分支，不经过
+     RespondStage）= LLMAgentStage 直接触发 null——SSE 端点据此关闭，防挂起

### LLMAgentStage 流式分支

+ - 检测 `event.getExtra('on_chunk')` → 调 `runner.runStream(..., onChunk)`（§6.1.2）；
+   文本/reasoning 块逐块回调；回复链/usage 记录/回写记忆/日志与非流式一致
+ - 3 处 aborted 分支（生成中断/竞态双保险）额外调 `on_done(null)` 后 return
+ - **非流式路径不变**：无 on_chunk 的事件（QQ/Telegram/OneBot）继续 runner.run()

### WebUI 会话与端点

+ - 会话命名：`webui::private:<uuid>`（平台前缀 webui，含 ':private:' 归入私聊记忆隔离；
+   与 QQ 通道完全隔离）
+ - `POST /api/chat/prompt`：构造 MessageEvent → eventBus.put（走完整 pipeline：
+   记忆检索/合并器/LLM/回写），send 回调收集完整回复，90s 超时
+ - `POST /api/chat/stream`：同上 + on_chunk 逐块 SSE 帧；on_done(chain) 收尾帧；
+   on_done(null) 发 abort 帧（合并打断/竞态）
+ - `GET /api/sessions/:id/messages?limit=&before=`：会话消息历史（events 表 created_at
+   游标分页，首页取最新，按消息边界）
+ - `GET /api/chat/pending?sessionId=`：Coalescer AbortRegistry.isInFlight——页面刷新恢复
+   "回复中"状态
+ - `MemoryManager.getSessionMessages(sessionId, limit, before?)`：分页游标读取
+   （Web-API 契约登记）

（未列行与旧 spec 一致。）

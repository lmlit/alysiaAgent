# Tasks: webui-chat-endpoints

## 实现任务

- [x] 1. core `pipeline/types.ts`:PipelineExtras 加 `on_chunk`、`on_done`
- [x] 2. core `llm-agent.ts`:检测 `on_chunk` → `runner.runStream` 分支;3 处 aborted 分支调 `on_done(null)`;正常路径包装 event.send 触发 on_done(chain)
- [x] 3. core `MemoryManager.getSessionMessages` + EventStore `getMessagesBySession`(created_at 游标分页)
- [x] 4. server `webui/chat.ts`:MessageEvent 工厂(裸 sessionId,unifiedMsgOrigin = webui:private:<id>)+ `POST /api/chat/prompt`(send 收集 + 90s 超时 + 空回复兜底)
- [x] 5. server `webui/chat.ts`:`POST /api/chat/stream` — SSE(connected/chunk/done/aborted/error 帧,on_done 统一收尾防挂起)
- [x] 6. server `webui/chat.ts`:`GET /api/sessions/:id/messages` + `GET /api/chat/pending`
- [x] 7. webui/server.ts 挂载 + core `isGenerating`(coalescer 成员化)+ Web-API-Design.md 登记
- [x] 8. 测试:llm-agent 流式分支 3 个 + webui-chat 端点 7 个全绿;core 358 + server 100 全量回归;build 0 错误

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/alysia-architecture/spec.md`
- [ ] 更新 `openspec/specs/index.md`（alysia-architecture 最后变更行）
- [ ] 运行测试验证 + 汇报

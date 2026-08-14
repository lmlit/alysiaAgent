# Tasks: llm-streaming-pipeline

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] 1. `provider/openai.ts` `textChatStream` 补齐:sampling 注入、60s 超时 race(Promise.race 共用 deadline:fetch 阶段 + 读循环阶段)、signal→AbortController、reasoning_content 透传、usage 透传
- [x] 2. `provider/manager.ts` `streamWithFallback(req)`:首 chunk 偷看模式——首 chunk 前 err → 切 fallback;已出 chunk 后 err → 透出终止;signal.aborted 不切 fallback
- [x] 3. `agent/runner.ts` 流式出口 `runStream(..., onChunk)`:文本/reasoning chunk 逐块回调;工具调用阶段无文本流(非 chunk 块走工具执行);流循环内 signal 检查 + 终检 + aborted 丢弃
- [x] 4. 测试:openai-stream(8:SSE 解析/sampling 注入/超时 race×2/abort/reasoning 透传/工具累积/非200)+ manager-stream(4:首 chunk 前切换/中途终止/全失败/abort)+ runner-stream(6:chunk 顺序/reasoning/工具循环/usage 累积/abort/全失败)= 18 全绿
- [x] 5. 全量回归:core 355(非 E2E)+ build 通过——QQ 主路径非流式零影响

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/alysia-architecture/spec.md`
- [ ] 更新 `openspec/specs/index.md`（alysia-architecture 最后变更行）
- [ ] 运行测试验证 + 汇报

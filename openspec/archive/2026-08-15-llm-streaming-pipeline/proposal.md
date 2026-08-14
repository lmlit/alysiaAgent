# Change Proposal: llm-streaming-pipeline

## 元信息

- **日期**: 2026-08-15
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `alysia-architecture`（Agent Runner §6.1 新增流式输出契约）

## 动机（为什么做）

WebUI（docs/WebUI-PRD.md, M0）需要**流式对话**：用户打字后逐块看到回复。当前
`OpenAIProvider.textChatStream` 已实现（SSE 解析 + chunk yield + tool_calls 累积）但
**零调用者**，且与 `textChat` 不对等：缺 sampling 注入、60s 超时 race、signal 打断、
response_format、reasoning_content 透传。ProviderManager 无流式 fallback 路由，AgentRunner
无流式出口。**主路径（QQ 通道）保持非流式不变**——本 change 只新增能力，不改旧行为。

## 需求（做什么）

- [ ] `textChatStream` 补齐与 `textChat` 对等能力：sampling 槽位注入、60s 超时 race（Promise.race 同模式）、外部 signal 打断（AbortController 透传）、`reasoning_content` 透传（DeepSeek reasoning 模型）
- [ ] `ProviderManager.streamWithFallback`：流式 fallback 路由——**仅首个 chunk 前的 err 触发切换**（headers/fetch 失败），已出 chunk 后失败直接终止（防丢前半）
- [ ] AgentRunner 新增流式出口 `runStream(..., onChunk)`：文本 chunk 逐块回调;工具调用阶段无文本流（工具循环保持完整执行）
- [ ] 流式与打断语义对齐：signal abort 检查点、aborted 结果丢弃（与 §6.1.1 契约一致）
- [ ] 主路径零影响：QQ 通道继续 `textChatWithFallback`，全量回归

## 设计决策（怎么做，含备选与取舍）

1. **onChunk 回调 vs 返回 AsyncGenerator**:runner 层用回调（`runStream(..., onChunk)`）——
   调用方（服务端 SSE）拿到 chunk 即写响应;runner 内部循环结构不变（文本生成阶段调用
   流式 provider,其余阶段同现有）。
2. **流式 fallback 只在首 chunk 前切**:流式中途 provider 失败重试会丢前半回复（用户已看到
   半句再重来 = 体验断裂）,不如直接终止。备选（dsh waterfall 整体重试）被否——它面向
   内部代理循环,我们面向用户可见流。
3. **reasoning_content 透传**:DeepSeek 是 reasoning 模型,流式 chunk 带 `delta.reasoning_content`
   （思考过程）。透传成独立事件字段,由调用方决定展示（WebUI 可做"思考中"折叠区）。
4. **response_format json + 流式**:不组合（json_object 模式用于非流式结构化输出,如 Life
   事件生成）。流式面向对话文本,不需要。
5. **signal 语义对齐**:流式请求同样支持外部 abort（Coalescer 打断语义）——abort 后
   `onChunk` 停止、结果丢弃,与 §6.1.1 契约一致。

## 对账方向确认

- [ ] 是否与现有 spec 冲突？—— `server-optimization`(frozen) 声明"不做流式输出"是当时范围
  决策（历史快照,不改）;`alysia-architecture`(active) 无流式覆盖 → 本 change 新增 §6.1.2
- [ ] 涉及 Web API？—— 否（core 层能力;server 端 chat/stream 端点是下一 change:
  `webui-chat-endpoints`,届时更新 Web-API-Design.md）

## 测试计划

- provider:流式 SSE 解析(chunk 逐块/reasoning_content 透传/tool_calls 累积)、sampling
  注入断言、60s 超时 race(fake timers)、signal abort 立即停止
- manager:streamWithFallback 首 chunk 前失败切换/出 chunk 后失败终止/abort 不切 fallback
- runner:runStream chunk 回调顺序、工具循环中无文本流、aborted 丢弃
- 回归:全量测试(QQ 主路径非流式行为不变)

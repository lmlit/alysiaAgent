# Spec 变更: alysia-architecture §6.1.2（LLM 流式输出）

> apply 用——变更行用 `+` 标记。未列行与旧 spec 一致。
> 影响主 spec：`openspec/specs/alysia-architecture/spec.md`（§6.1.1 打断契约之后插入）

### 6.1.2 流式输出契约（2026-08-15，change: llm-streaming-pipeline）

+ **能力分层**：OpenAIProvider.textChatStream 补齐与 textChat 对等的完整能力
+ （此前已实现 SSE 解析 + chunk yield + tool_calls 累积，但零调用者）：
+   - sampling 槽位注入（同 textChat：undefined 字段不传）
+   - 60s 超时 race（Promise.race([fetch, timeoutPromise]) 同 §6.1.1 模式；
+     超时 → err chunk + 终止；挂起 fetch 的 rejection 用 .catch(() => {}) 吞掉）
+   - 外部 signal → AbortController 透传（abort 后流停止）
+   - `reasoning_content` 透传（DeepSeek reasoning 模型思考过程，独立字段标记，
+     由调用方决定展示——WebUI 可做"思考中"折叠区）
+   - 不与 response_format=json 组合（json_object 仅非流式结构化输出用）
+ - 文本块 yield：`{ role:'assistant', completionText, isChunk:true }`
+ - 工具调用在流式响应里照旧累积后一次性 yield（流式不改变工具循环语义）
+
+ **ProviderManager.streamWithFallback(req)**：流式 fallback 路由——
+ - 仅**首个 chunk 前**的 err（fetch/headers 失败）触发切换 fallback provider；
+   已开始出 chunk 后失败 → 直接终止（重试会丢前半回复 = 体验断裂）
+ - signal.aborted 时不切 fallback（与 textChatWithFallback 同检查点）
+
+ **AgentRunner.runStream(..., onChunk)**：流式出口
+ - 文本生成阶段调 streamWithFallback，文本 chunk 逐块回调 onChunk
+ - 工具调用阶段无文本流（工具循环保持完整执行，与 §6.1 Tool-Loop 相同）
+ - 打断语义与 §6.1.1 一致：signal 检查点 + 终检；aborted 结果永不发送
+ - **主路径不变**：QQ 通道继续 textChatWithFallback 非流式，行为零影响
+
+ （未列行与旧 spec 一致。）

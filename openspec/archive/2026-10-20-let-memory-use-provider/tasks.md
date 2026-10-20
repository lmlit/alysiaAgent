# Tasks: let-memory-use-provider

- [x] `ProviderRequest.timeoutMs?`（缺省 60000，聊天链路零变化）
- [x] `openai.ts` 按请求覆盖超时；超时文案按实际秒数生成
- [x] `MemoryLlmClient`：`provider` / `providerRef`（懒取）/ `fallbackIds`
- [x] `completeViaProvider()`：带 120s、翻译错误语义、保留 `[LLM:memory]`
- [x] `HttpEndpointConfig.viaProvider?`（缺省 false）
- [x] `memoryLlmModule` 用 `providerRef`（**不用 inject**，理由见 proposal）
- [x] 测试 `memory-llm-via-provider.test.ts`（7 条）：
      - 不传 provider ⇒ 仍直连（默认不变）
      - 传了 ⇒ 走它且 `timeoutMs === 120_000`
      - provider 超时 ⇒ 中文「LLM 请求超时（120s）」
      - provider API error ⇒ `LLM API error <status>: <body>`
      - 走 provider 仍打 `[LLM:memory]` 且含 tokens/finish
      - 空内容仍 warn + 返回空串
      - providerRef 懒取
- [x] 全量：**141 文件 / 1762 测试全绿**
- [x] `memory-system` 契约 7.5 + 归档 + 索引 + TODO + HANDOFF

## 下一步

B4 人格联动 v2（`memory_config` 增量，复用 5 道护栏）。**B5/B6 等用户拍板。**

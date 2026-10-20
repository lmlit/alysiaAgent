# Tasks: unify-memory-llm-client

- [x] 新建 `packages/core/src/memory/services/MemoryLlmClient.ts`
      （逐字搬生产逻辑：超时 race+abort、`[LLM:memory]` 观测、空响应 warn）
- [x] `modules/resources.ts`：`al:memory-llm` 改用该类，删掉内联实现与本地常量
      （⚠️ 拼接用 **Node 脚本**做的 —— PowerShell 在这台机器上会毁掉 UTF-8 中文，实测踩过一次）
- [x] `OpenAILLMService` 改为委托 `MemoryLlmClient`（保留构造签名与默认槽语义）
- [x] 契约测试 `packages/core/tests/memory/unit/memory-llm-contract.test.ts`（5 条）
- [x] **顺手修掉一个真缺陷**：超时错误被底层 `AbortError` 顶掉（`race` 谁先落定谁赢）
      ⇒ 用 `timedOut` 标志在 catch 里统一重写，保证契约 6.2 的「可读错误」成立
- [x] `memory-system` spec 新增 §4.1.4（契约 7 / 7.1 / 7.2 / 7.3）
- [x] 全量测试（Node 24，免 API 一遍）：135 文件 / 1716 测试全绿
- [x] 归档 + 更新索引 + KI-3/KI-9 + TODO 销账

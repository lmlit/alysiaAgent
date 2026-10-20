# Change Proposal: unify-memory-llm-client

## 元信息

- **日期**: 2026-10-20
- **类型**: REFACTOR（消除双实现，接上契约测试）
- **状态**: pending → 本轮直接 apply
- **影响 spec**: `memory-system`（§4 客户端契约补一节「唯一实现 + 契约测试」）
- **KI**: KI-3、KI-9（**同根因**，一起收）

## 这条要解决什么

记忆链路有**两套 LLM 客户端**：

| | 生产 | 测试/E2E |
|---|---|---|
| 类 | `modules/resources.ts` 的内联字面量（`al:memory-llm`） | `memory/services/OpenAILLMService.ts` |
| 超时 | ✅ 120s（`MEMORY_LLM_TIMEOUT_MS`，KI-21 的修复） | ❌ **没有** |
| 观测 | ✅ `[LLM:memory]` + 空响应 `EMPTY content` 分支 | ❌ **没有** |
| `sampling` 语义 | 透传（缺省 = 不带采样字段） | 构造函数塞默认 `profile.extract` 槽 |

**它们已经分叉了**，而且分叉方向最坏：E2E 测的那个客户端**没有超时、没有日志**。
KI-3 说的正是这个——「两者行为现已一致」这句在 KI-21 落地后**已经不成立**。

历史代价：`OpenAILLMService.complete` 曾少声明一个形参静默丢弃 `sampling`，
导致 `CronProcessor.deepProfile` 被套上 `response_format: json_object` → API 400，
**而 E2E 没发现**（因为它测的就是那个错实现）。

## 需求

1. **抽一个正式类** `memory/services/MemoryLlmClient.ts`
   - `constructor(config: {baseUrl, apiKey, model}, opts: {logger, timeoutMs?})`
   - `complete(systemPrompt, userPrompt, sampling?)`：**照搬**生产逻辑（超时 race+abort、
     `[LLM:memory]` 观测、空响应 warn）——**逐字搬，不顺手改行为**
2. **生产改用它**：`resources.ts` 的 `al:memory-llm` = `new MemoryLlmClient(...)`，
   `MEMORY_LLM_TIMEOUT_MS` 移进类（模块层只传配置）
3. **`OpenAILLMService` 改成同一实现的适配器**（保留构造签名，E2E 不用改）
   - 这样 E2E **从此真的覆盖生产路径**（含超时与日志）
   - 「构造函数默认槽」这个便利**保留但写进注释**：它仍是两条入口唯一的行为差异
4. **契约测试**（KI-3 的正题）
   - mock 全局 `fetch`，同一 slot 经两个入口调用 ⇒ **request body 必须逐字相同**
   - 再断言两者都带 `signal`（超时能力不是生产独有）

## 不做

- **不收编进 ProviderManager**（那是「无 fallback / 无 signal 透传」那条历史债，
  改动面横跨两条链路，须独立 change —— 见 `docs/dsh-plugin-architecture.md` §5）
- 不改 `MEMORY_LLM_TIMEOUT_MS = 120_000`（它是实测定的，见原注释）
- 不改 `ILLMService` 接口

## 风险

- E2E 现在会走**带超时**的路径 ⇒ 若某 E2E 用例本来就慢，可能变成显式失败（**这是好事**，
  但要在跑的时候确认不是误报）
- `OpenAILLMService` 的默认槽语义若被误改，E2E 的「低温提取」假设会崩 ⇒ 契约测试锁住它

## 对账方向

KI-9 = 生产没用品类实现 ⇒ **改 impl（统一到一个类）**，而不是把 doc 改成「仅测试用」放过它。

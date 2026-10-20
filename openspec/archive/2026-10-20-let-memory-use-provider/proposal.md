# Change Proposal: let-memory-use-provider

## 元信息

- **日期**: 2026-10-20
- **类型**: FEATURE（**B 类：能力新增，默认关闭**）
- **状态**: `applied`
- **影响 spec**: `memory-system` §4.1.4 **契约 7.5**
- **用户授权**: 「AB 都做吧」（B3 = 收编 ProviderManager 补 fallback）

## 这条要解决什么

记忆链路**绕开 `ProviderManager` 直连 fetch**，因此没有 fallback：
主 provider 挂了，摘要/画像/cron 重写/人格调整**一律失败**，而聊天还在正常跑。

## ★ 判断：能力做，默认不开

做完之后我没有默认打开它，理由写在 spec 契约 7.5：

| 理由 | 说明 |
|---|---|
| **收益是 0（今天）** | 只注册了一个 provider ⇒ fallback 空转 |
| **代价是真的** | 走 provider 会多打一行 `[LLM]`，而契约 5 钉的是 `[LLM:memory]` ⇒ **token 统计重复计数** |
| **新失败面** | 错误文案由 provider 生成，本类要多一层翻译 |

所以形态是：**开关 + 等价性测试 + 明确的打开前提**。这不是"没做完"，
而是"把风险定价之后留在关的位置"——比较一下 B2 那个 0.3 系数就懂了：
没被测试拦住的"顺手打开"才是真危险。

## 需求

1. `ProviderRequest.timeoutMs?`（缺省 60000 ⇒ 聊天链路**零变化**）
2. `MemoryLlmClient` 增 `provider` / `providerRef` / `fallbackIds`
3. `HttpEndpointConfig.viaProvider?`（缺省 false）
4. 走 provider 时**必须**：
   - 把 `MEMORY_LLM_TIMEOUT_MS`（120s）带过去
   - 把 `{role:'err'}` 翻译回契约 6.2 / 7.4 的文案
   - 保留本类的 `[LLM:memory]` 观测行
5. **不做 `inject`**：用 `providerRef` 懒取（见下）

## 为什么用 providerRef 而不是 inject

`al:memory-llm` 与 `al:provider` **没有依赖关系**。声明 `inject: ['al:provider']` 会：

- 锁死两个模块的装配顺序（内核按 inject 拓扑，本来不需要）
- 让 **10 个只测 memory-llm 的既有单测全部要加 provider 桩** —— 那是**为功能付的假成本**

懒取（`() => ctx.get('al:provider')`）在调用时才解析 ⇒ 装配顺序无关，
未启用时连一次 `ctx.get` 都不发生。

## 不做什么

- 不改聊天链路的 60s（缺省值不变）
- 不加第二个 provider（那是部署配置，不是代码）
- 不改 `[LLM]` 的格式（provider 层观测保持原样）

## 回滚

`viaProvider: false`（或删掉该键）⇒ 回到直连 fetch，行为与改造前一致。

## 对账方向

spec 早写着「绕开 ProviderManager 是历史现状，收编是独立 change」⇒ 本 change 履约，
并把"能收编但默认不开"的判断**写成契约**，避免下一个人看到代码支持就以为该默认打开。

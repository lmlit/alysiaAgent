# Change Proposal: tidy-a-class-seams

## 元信息

- **日期**: 2026-10-20
- **类型**: REFACTOR（**A 类：行为不变**）+ 测试补充
- **状态**: `applied`
- **影响 spec**: `memory-system` §4.1.4（补契约 7.4）、§4.1.5（补 A4 说明）
- **上游**: `organize-prompt-layer`（A1/A2 已归档）

## 这条要解决什么

A 类余下两项 —— 都是"让分叉无处可藏"的收尾。

### A4：验证脚本里的 prompt 副本

`packages/server/scripts/` 有 5 处提示词。查过之后分两类，**处理方式必须不同**：

| 脚本 | 性质 | 处理 |
|---|---|---|
| `verify-session-summary-fix.ts` | 与 `SESSION_SUMMARY_SYSTEM_PROMPT` **逐字相同**的副本 | ✅ **改 import**（副本注释还写着"保持一致"——那种一致靠人守） |
| `life-e2e-verify.ts` | **故意简化**的变体（1-2 句 + 最小 schema） | ⚠️ 加注释标明"故意 ≠ 生产，别当 bug 修" |
| `verify-micro-narrative.ts` | 同上（只验微叙事那一条约束） | ⚠️ 同上 |
| `show-life-effect.ts` | 同上（只留首句，避免提示词盖过要观察的上下文） | ⚠️ 同上 |
| `digest-worldbook.ts` | 独有提示词（世界书整理），没有生产对应物 | 不动 |

**为什么不能一律改 import**：那三处简化是有目的的诊断变体；
把它们"统一"成生产提示词会**让诊断脚本失灵**（噪音盖过要验的东西）。
所以要消灭的不是"变体"，是"**看起来像副本、其实是变体**"这种歧义。

为此把 4 个记忆提示词**导出到 `@alysia/core/memory`** barrel
（core 的 package.json 不暴露深路径，脚本只能经 barrel 拿）。

### A3：客户端契约只锁了 body，没锁信封

`memory-llm-contract.test.ts` 原来只断言 request body 相等。
但两条链路若在**URL 拼接 / 请求头 / 错误文案**上分叉，排查时最先看到的正是这三样
（"key 没带？""路径拼错？""报错格式不一样？"）。补三条断言：

1. URL 与两个请求头（`Content-Type` / `Authorization`）逐字相同
2. 错误文案同形：`LLM API error <status>: <body>`
3. 默认超时锁 `MEMORY_LLM_TIMEOUT_MS = 120_000`（契约 6.1 的批处理口径）

## 不做什么

- **不改**任何生产代码的请求/响应行为（A3 全是测试；A4 只动 scripts 与非脚本的导出面）
- 不动 `digest-worldbook.ts`（它没有对应物，不存在漂移）
- 不把诊断变体"统一"成生产提示词（见上）

## 行为变化的唯一一处（诚实记录）

`verify-session-summary-fix.ts` 用上生产常量后，**脚本行为随主线走** ——
这正是目的（它验的就是主线摘要）。但它是诊断脚本，不进生产链路。

## 对账方向

spec 没写过"脚本里的提示词副本要不要统一" ⇒ 本 change **补 doc**（§4.1.5 的 A4 段）。

# Tasks: add-memory-llm-timeout

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## core · `al:memory-llm` 超时

- [x] `src/modules/resources.ts`：新增模块级常量 `MEMORY_LLM_TIMEOUT_MS = 120_000`
      （含「为什么是 120s 不是 60s」的完整理由注释）
- [x] `memoryLlmModule.complete()`：
      - `AbortController`，其 `signal` 传进 `fetch`
      - `Promise.race([fetchPromise, timeoutPromise])`；超时 promise 触发时
        **先 `controller.abort()` 再 `reject`**
      - `fetchPromise.catch(() => {})` 防 unhandledRejection
      - `finally { clearTimeout(timeoutTimer) }`（成功路径也要清，否则挂个空转定时器）
      - 超时错误消息：`LLM 请求超时（120s）`
- [x] 非 2xx 的既有 `throw`（含响应体）**保持不变**
- [x] `[LLM:memory]` 观测行（上一刀加的）**保持不动**

## 测试

- [x] `packages/core/tests/modules/resources.test.ts` 的 `al:memory-llm` 块追加 3 条：
      - ★ 请求永不 resolve → 在超时点抛错，消息含「超时」（fake timers）
      - ★ 超时后底层 fetch 的 `AbortSignal` 处于 **aborted**（且超时前未 aborted）
      - 正常路径也把 `AbortSignal` 接线到 fetch（证明机制不是摆设）
- [x] 既有用例全绿（见验收表）
- [x] `tsc --noEmit` 退出码 0

## 文档

- [x] `openspec/specs/memory-system/spec.md` §4.1.3：改写「边界」段 + 新增契约 6
      （6.1 超时值 / 6.2 抛错不返回空串 / 6.3 必须 abort / 6.4 是延迟不是丢失）
- [x] `docs/KNOWN-ISSUES.md` KI-21：状态改为「**已修**」，保留原始实测记录作依据
- [x] `docs/Web-API-Design.md` §2.2：补「慢请求 2 分钟内失败」的行为说明

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [x] 更新 `openspec/specs/index.md`（`memory-system` 的「最后变更」）
- [x] 从 index.md 的「尚未开 change 的缺陷」列表里**移除 KI-21**
- [x] core build：由 `packages/server/Dockerfile` 在容器内 `pnpm -r build` 完成
- [x] 构建镜像 → 部署 → 验证
- [x] 更新 `docs/HANDOFF.md`
- [x] 归档 + 更新索引

## 验收结果（2026-10-11 下午）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **641 passed / 66 files**（较上一刀 +3） |
| 新增超时用例 | ✅ **3 passed**（含 abort 断言） |
| `tsc --noEmit` | ✅ 退出码 0 |
| 部署 | ✅ 镜像 `85118003da4d`；回滚锚点 `server-alysia:rollback-20261011b`；DB 备份 `alysia.db.bak-before-timeoutfix`；healthy / `10/10` 模块 / QQ ONLINE |
| 线上验证 1：`extractProfile` 耗时 | ✅ **14818ms（15s）**，返回 `{"factsExtracted":0,"summaryGenerated":true}`<br>对照修复前同入口：**7039529ms（117 分钟）** |
| 线上验证 2：`[LLM:memory]` 观测未破坏 | ✅ `tokens=301+1852=2153 finish=stop reasoning=1763 (9388ms)` |
| 线上验证 3：窗口修复未回退 | ✅ 新摘要行 `span=1.2h / mc=1`；`summary_status='failed'` = 0 |
| 线上验证 4：无网络异常 | ✅ 近 10 分钟 `fetch failed` = 0 |

> 超时本身的**正向验证**（真的超时）只在单测里做——线上无法安全制造断网。
> 单测用 `vi.useFakeTimers` 精确推进 120s 并断言 `signal.aborted === true`。

## ★ 副产物：拿到两条关键预算数据（供后续决策）

同一天 `[LLM:memory]` 采到的会话摘要槽样本：

| 时刻 | output tokens | reasoning tokens | reasoning 占比 | 可见内容 |
|---|---|---|---|---|
| 10:11:46 | 1081 | **882** | **82%** | ~199 |
| 13:40:43 | 1852 | **1763** | **95%** | **~89** |

`session.summary` 的 `max_tokens` 是 **2048**。第二条只剩 **~196 tokens 余量**——
**再膨胀一次就会 `finish=length` 截断**，正是线上那 4 次 `truncated=true` 的成因。
**建议**：这条数据并入 `decide-life-event-max-tokens` 一起决策，
摘要槽同样需要更大的预算（或把 reasoning 与 content 的预算解耦）。

## 刻意不做（记录在案）

- ❌ **不改 provider 的 60s**（聊天链路已达标）
- ❌ **不加 fallback provider**（属收编 ProviderManager，独立 change）
- ❌ **不加外部 `signal` 透传**（四个槽位目前无打断需求）
- ❌ **不把超时做成配置项**（与 provider 的 60s 一致保持硬编码）
- ❌ **本 change 不动任何 `max_tokens` 数值**（要按契约 4 的口径另行决策）

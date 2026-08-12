# Change Proposal: llm-request-timeout-race

## 元信息

- **日期**: 2026-08-12
- **类型**: FIX（60s 超时在网络故障时失效，请求挂 566s）
- **状态**: pending
- **影响 spec**: alysia-architecture（§6.1.1 abort 契约 / 超时语义）

## 动机（为什么做）

线上宕机复盘（8-12 04:50-09:06 宿主网络故障）发现：`[LLM] request error:
fetch failed (566365ms)`——60s 超时未生效，请求挂了 9.4 分钟。

根因：openai.ts 的 60s 超时用 `setTimeout(() => controller.abort())` +
fetch 的 `signal`——但 **undici fetch 的 DNS 解析/连接建立阶段无法被
AbortSignal 中断**（libuv getaddrinfo 提交线程池后不可取消）。网络故障
（DNS 无响应）时 abort 传不到底层，fetch 挂到 DNS 系统级超时才以
`TypeError: fetch failed` 拒绝（非 AbortError），走错 catch 分支。

## 需求（做什么）

1. **60s 超时改用 `Promise.race([fetch, timeoutPromise])`**——不依赖
   AbortSignal 传播，到点准时返回 `Request timed out (60s)`
2. **吞掉挂起 fetch 的最终 rejection**（`.catch(() => {})`）——race 已返回
   后底层请求最终失败不能 unhandledRejection
3. **外部 signal（打断）仍走 AbortController**——请求已发出后 abort 有效
   （打断语义不变，token usage ≈ 0 验证锚点保留）

## 设计决策

- race 方案的代价：超时后底层挂起的连接仍占用资源直到系统层超时——但主流程
  不再被阻塞（566s → 60s），可接受
- AbortError catch 分支统一处理两种超时来源（race reject 也标 AbortError）

## 对账方向确认

- [x] impl 缺陷（超时机制到不了 DNS 层）→ 本 change 记录修复

## 测试计划

- fetch 永久挂起（不 reject 不响应 abort）→ 60s 准时 timed out（fake timers：
  59s 不 resolve，61s 返回 timed out）
- 正常请求 / 外部 signal abort / API 非 200 → 行为不变
- 全量回归

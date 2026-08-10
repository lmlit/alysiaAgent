# Change Proposal: input-coalescing-and-abort

## 元信息

- **日期**: 2026-08-10
- **类型**: MODIFY（新行为：输入合并 + 在飞请求打断）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.2 Pipeline / §6 Agent Runner 新增小节）

## 动机（为什么做）

每条入站消息触发一次 LLM 请求，用户连续分条发会并行触发多条回复，体验混乱。

## 需求（做什么）

1. 合并窗口：同一 session（私聊）第一条消息到达起 debounce 窗口（10s，每次新消息重置，
   用户拍板），窗口内后续消息合并为一条请求（换行拼接）
2. 打断在飞：与窗口正交——任何新消息到达时，若该 session 有正在生成的 LLM 请求，打断它，
   合并后重新发起（不限 2s 内）
3. 图片预热：窗口内图片一到就并行 VisionBridge.describe，flush 时 await 全部 pending 描述再合并
4. 群聊不合并不打断（用户拍板：群聊保持现状，每条都触发回复）
5. 采样配置项（可选）：coalescing: { debounceMs: 2000, maxWaitMs: 5000 }

## 设计决策

- **落点**: pipeline 内新增 `CoalescerStage`（插在 memory-ingest 之后、worldbook 之前）——
  单点实现，全部适配器自动覆盖；依赖 scheduler 对 async generator "不 yield 直接 return
  则后续 stage 不执行" 的既有机制，不改 scheduler
- **忠实 EventLog**: 每条原始消息照常跑 pii-filter → memory-ingest（独立 ingest）；
  合并事件带 `coalesced` 标记，pii-filter/memory-ingest 跳过（文本已脱敏、避免双计）
- **flush 重入**: 合并事件（messageStr 换行拼接 + 图片组件聚合 + 描述文本前置）
  → `scheduler.execute(mergedEvent)`（串行安全：EventBus dispatch 逐事件处理）
- **打断**: `AbortRegistry`（Map<sessionId, AbortController>）——新消息到达即 abort 旧 controller；
  llm-agent 从 registry 取 signal → runner → ProviderRequest.signal → openai.ts fetch
- **abort 必须真到 fetch**: openai.ts 外部 signal 与 60s timeout 组合（addEventListener），
  日志区分 `aborted by signal`；manager fallback 循环在 signal.aborted 时不再切 provider
  （否则 abort 会误触发 provider 切换烧钱）
- **非流式打断干净**: 生成完成才发送，打断发生在 gen 阶段 = 无已发内容，丢弃即可；
  runner 返回 `aborted` 标记，llm-agent 不 setExtra response_chain、不回写 EventLog
- **图片描述**: qq-official.ts 由同步 await 改为 fire-and-forget 挂 `pending_image_descs` extra；
  Coalescer 对私聊 flush 时 await 全部拼 `[图片内容: ...]`；对群聊/非合并路径也 await 拼接后
  继续（保持现有行为）

## 对账方向确认

- [x] 新增行为，不冲突现有 spec（pipeline-contract frozen 只读，挂 alysia-architecture）

## 测试计划

- 连发 3 条 → 只回 1 条合并回复；EventLog 有 3 条原始 user 消息（不丢、不双计）
- 发 1 条等生成中再发 1 条 → 上一条被打断、合并重发
- 日志验 abort 真到 fetch：被打断的 gen token usage ≈ 0
- 群聊消息不合并（直接放行）
- 合并事件不重复 ingest（coalesced 标记跳过）

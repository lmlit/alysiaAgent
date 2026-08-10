# Change Proposal: eventbus-concurrent-private-dispatch

## 元信息

- **日期**: 2026-08-10
- **类型**: FIX（Coalescer 合并失效根因：EventBus 串行调度）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.5 输入合并 + 打断）

## 动机（为什么做）

线上实测（2026-08-10 22:12 日志）：连发三条私聊消息，三条各自独立回复，
Coalescer 打断/合并【完全不触发】。根因：`EventBus._dispatchLoop` 对每条消息
`await scheduler.execute(event)` 串行处理——消息 B 在队列里等 A 的整条
pipeline 结束（LLM 生成 + 图片上传）才 dispatch；等 B 开始处理时 A 的
controller 早已 `release` → `isInFlight` 恒为 false → 打断分支永远进不去。
Coalescer 的设计前提是"多条消息并发在飞"（B 到达时 A 还在生成），
EventBus 串行违背该前提，合并机制自上线起空转。

顺带：日志清理只在启动时执行一次（`logger.configure` → `cleanupOldLogs`），
长跑容器内旧日志不清理，7 天后保留 7 天。

## 需求（做什么）

1. **EventBus 私聊并发**：私聊事件 fire-and-forget（`scheduler.execute(event)`
   不 await）——每条私聊消息立即进 pipeline，A 在飞时 B 到达 → Coalescer
   `isInFlight` 判定成立 → abort + 合并（用户拍板的行为才可能发生）
2. **群聊保持串行**：群聊事件仍 `await`——维持用户拍板"群聊逐条回复"
3. **合并事件插队**：`put(event, { priority })` → unshift 队首——flush 的
   合并事件优先于排队中的其他消息处理（不乱序、不延迟）
4. **日志每日清理**：保留 7 天（用户拍板：清理太频繁丢失分析信息）——
   `logger.startDailyLogCleanup()`，每日一次 + 启动时已有清理

## 设计决策

- 并发安全：pipeline 各 stage 均无共享可变状态或使用 better-sqlite3 同步写
  （WAL）——PII 无状态 / ingest 同步 / Coalescer 同步 Map / worldbook 同步 /
  retrieval 读 / runner 每次新建 AgentContext / Respond 异步 API，私聊并发无竞态
- 私聊并发后 Coalescer 打断才成立：A 在飞 → B abort A + 入桶 → A 的
  aborted 分支 flush 合并 [A+B]（priority 插队）→ 合并事件串行重入 pipeline
- 日志清理周期 7 天为底线（用户要求保留分析信息），每日定时 + 启动各执行一次

## 对账方向确认

- [x] 已归档 change 的前提缺陷（EventBus 串行 vs 合并需要并发）→ 本 change 记录并修订

## 测试计划

- EventBus：私聊事件并发（execute 不被 await 阻塞，两条私聊同时跑）；
  群聊事件串行（await 后一条排队）；priority 插队（unshift 到队首）
- Coalescer：flush 调用 put(…, { priority: true })
- 日志清理：startDailyLogCleanup 立即清理 + 保留 7 天
- 既有 284 测试回归不破坏

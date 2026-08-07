# Tasks: proactive-greeting-context

## 实现任务

- [x] 问候上下文注入：contextSnippet() 组装用户近况 + 今天生活事件 + 亲密度，personalize 注入
- [x] 精确到点调度：scheduleNextGreeting() / fireGreeting()，tick 移除问候循环
- [x] 重启补发 + 失败重试（同 key 最多 2 次、间隔 10min）
- [x] 日志前缀统一 [Proactive]
- [x] 测试：调度到点计算/补发/去重/重试上限/上下文注入
- [x] qq-reconnect-backoff spec 补"平台 30 分钟强制重连"已知行为

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 openspec/specs/proactive-messages/spec.md（§2 架构 + §2.2 上下文注入）
- [x] 更新 openspec/specs/index.md（最后变更列）
- [x] tsc --noEmit + 全部测试通过
- [x] 提交

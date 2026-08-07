# Tasks: proactive-greeting-scheduler-fixes

## 实现任务

- [x] scheduleNextGreeting 单遍扫描重写（消除 bump 误伤 + 5s 死区）
- [x] fireGreeting：stopped / 窗口守卫（hour 检查）/ in-flight 防双发
- [x] scheduleRetry 提取（false + 异常路径共用重试预算）
- [x] stop() 置 stopped 标志
- [x] 测试：afterEach 补全 + 回归用例（P0 跨天 / P1 死区 / sleep 跨天 / 异常重试 / stop 后不发）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 openspec/specs/proactive-messages/spec.md（§2.1.6 调度语义补充）
- [x] 更新 openspec/specs/index.md
- [x] tsc --noEmit + server 全量测试通过
- [x] 提交

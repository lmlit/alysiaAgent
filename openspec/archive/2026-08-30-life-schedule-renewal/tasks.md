# Tasks: life-schedule-renewal

## 实现任务

- [ ] life.ts 锁续期：intervalMs(模型/保底) + baseIntervalMs(时段) + !evt 分支续期 + tick 异常兜底
- [ ] life.ts 补写渐变：≤1h 此刻 / 1-2h 轻 / >2h 重 + 延续链 ≥3 强制开新事
- [ ] life.ts 剧情链：listLifeEvents(1) 窗口 + 日期标注 + 8 条上限 + windowIds
- [ ] life.ts 事件日志加 next_in_hours 观测
- [ ] bootstrap.ts chat 上限 5→20
- [ ] 测试更新 + 新增

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [ ] 运行测试验证

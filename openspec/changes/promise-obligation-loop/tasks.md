# Tasks: promise-obligation-loop

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 life.ts processDueIntents：promise 分支改为 LLM 裁决（fulfill/defer/cancel）
- [ ] T2 bootstrap：generateIntentMessage 升级为裁决回调（prompt 带三选项 + 返回 JSON）
- [ ] T3 测试：裁决三分支 + 延期重排 + 取消推送

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`
- [ ] 运行测试验证

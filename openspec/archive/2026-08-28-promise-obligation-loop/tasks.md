# Tasks: promise-obligation-loop

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] T1 ai_life_intents 加 evidence 列（原始承诺句，解析时备份）——ALTER + try-catch
- [x] T2 llm-agent.ts POST 解析：evidence = 包含标记的原始回复句，随 saveIntent 入库
- [x] T3 LifeStore/MemoryManager：saveIntent 支持 evidence；listDueIntents 返回 evidence
- [x] T4 life.ts processDueIntents：promise/delayed-reply 统一三选一裁决（fulfill 兑现 / defer 延期重排 ≤2 次 / cancel 取消推送说明）
- [x] T5 bootstrap generateIntentMessage 升级为裁决回调：prompt 带【承诺原文 evidence + 内容 + 最近对话 + 当前状态】，返回 JSON {action, content, delay_hours?}
- [x] T6 测试：裁决三分支 / 延期重排（上限 2 次）/ 取消推送 / evidence 入库

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（★ 从主 spec 拷贝后追加）
- [x] 更新 `openspec/specs/index.md`
- [x] 运行测试验证

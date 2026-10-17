# Spec delta: return-project-task-result

> 合并去向：`openspec/specs/project-tasks/spec.md` **§10 结果回送**（契约 24–28）。
> 内容已直接写入主 spec（无逐行 `+` diff）。合并后已跑
> `scripts/check-spec-diff-residue.cjs`（exit 0）。

## 本 change 触及但**没有**改的地方

| 项 | 状态 |
|---|---|
| 任务状态机 | 未改（终态集合不变） |
| 委托会话的隔离 | 未改（仍 `skip_profile`/`synthetic`，仍不结算） |
| `PushChannel` 接口 | **可选参数**扩了一个 `opts?: {maxSegments?}` —— 生活/问候/提醒三条既有调用**无需改动** |
| 回执的长期记忆 | **未做**：回执不进摘要 ⇒ v1 只保证近期窗口可回忆 |

# Tasks: return-project-task-result

> **状态（2026-10-18）**：T1–T5 完成，已在生产端到端验证。
> ⚠️ 本 change 的 proposal 是**实现之后补写**的（用户连续两次"做"，我先动手了）——偏离已记录在 proposal 元信息里。

## 实现

- [x] **T1 core**：`buildProjectTaskResultEvent()`（纯函数）+ `MemoryManager.recordProjectTaskResult()`
      - 幂等 id `project-task:<taskId>:r<revision>`
      - 三个标记位：`skip_profile` / `synthetic` / `project_task_result`
      - `originSessionId` 为空 ⇒ 返回 null（**不猜目标会话**）
- [x] **T2 server 路由**：`POST /api/project-tasks/:id/result` 成功后 `void notifyProjectTaskResult(task)`
      - **不 await**：推送慢不许拖住 runner 的回传
      - 记回与推送**各自 try/catch**：通知失败不许改任务状态
      - 回传被拒（409）时**不触发**回送
- [x] **T3 推送接线**：`al:push` → `webui` 模块 → `createWebuiApp({push})`
      - 只在能解析出 QQ openid 时推；`webui:` / 测试会话**跳过并留痕**
- [x] **T4 回执带地址**：`projects.<id>.publicUrl` → 回执正文末尾一行「外网地址：…」
      - ★ 真机撞出来的：用户真的在 QQ 上问过"给我链接"，她答"我没存下地址"
- [x] **T5 通知只发一条**：`PushChannel.sendProactive(..., { maxSegments: 1 })`
      - ★ 真机撞出来的：QQ 实现对 >60 字/含换行的文本自动分段 ⇒ 一条通知被拆成 **3 条**消息

## 真机验证（生产）

- [x] 部署（只换镜像；回滚锚点 `rollback-20261018-005643`）
- [x] 新任务 → 15s → `needs_review`
- [x] **回执**落在真实 QQ 会话：`skip_profile=True` / `synthetic=project-task-result`，
      正文含 `外网地址：http://…:3389/`
- [x] **推送恰好 1 条**（修复前是 3 条），日志 `Proactive send → OK` + `结果推送成功`
- [x] 回执出现在该会话的**最近 2 条**里（她下一轮就能看到）

## 未做

- [ ] 长期记忆（回执**不进摘要** ⇒ 只保证近期窗口可回忆；要长期记住另立 change）
- [ ] 推送配额治理（合并/限流/静默时段）—— 目前在每次终态推一条
- [ ] 富通知（链接卡片/截图）

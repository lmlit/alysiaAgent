# Tasks: purge-subagent-pollution

> 纯数据操作（不改代码、不动 spec）。**执行前必须：① 用户确认清单 ② 备份**。
> 判定一律查库，不看日志。清单见 proposal.md。

## 前置

- [x] 用户确认清单（拍板：facts 保留 / events 保留 / 参数不回滚）
- [ ] 确认桌面端已重启（新 dist 生效，否则边清边进）——**⚠️ 执行时桌面端仍在跑旧 dist 的活会话**
- [x] 备份 `packages/server/data/alysia.db` → `VACUUM INTO 'alysia.db.bak-before-subagent-purge'`（3.27 MB）

## 执行

- [x] A1 删 conversations 12 行（子会话）
- [x] A2 删 facts 3 条（工程任务类）
- [x] A3 删 character_facts 12 条（子来源）
- [x] A4 删 hints 4 条（工程来源）
- [x] 顺带清 `dsh:logtest`（1 条测试事件）
- [x] C 参数回滚 —— **用户拍板不做**
- [x] B events 去留 —— **用户拍板保留**

> 执行脚本一次成功、一次被断言拦下（`source_event` 前缀写作 `dsh-<uuid>-` 漏拼前缀 → cDel=0 →
> **事务整体回滚**，数据未动）。修正后 `{a1:12, fDel:3, cDel:12, hDel:4, lt:1}` 全部命中预期。

## 验证

- [x] 重跑盘点：A1 残留 **0**、character_facts 子来源残留 **0**、3 条工程 facts 查无、4 条 hints 查无
- [x] 抽样：长沙 12 / 颜文字 9 / 显示器 7 / 新业务线 4 —— B 类覆盖全在
- [x] ⚠️ 总数口径说明：hints 103→102、events 1403→1409 —— **不是清理漏了**，
      而是**库是活的**（执行时桌面端正跑 `dsh:session-29b9865c`，实时进了 7 条事件 + 3 条 hints，
      全部来自主会话实时活动，按口径保留）。子会话事件数 127 未变。
- [ ] 桌面端重启后实聊一句，确认 `[关于你]`/画像正常（没被清空）——**留给用户重启后验**

## 收尾

- [x] 登记 KI-20（执行中发现：runtime context 快照被当 user 消息回传，主会话同病）
- [x] 更新 `docs/HANDOFF.md`（清理结果 + 备份文件名 + KI-20）
- [x] archive 到 `openspec/archive/2026-10-02-purge-subagent-pollution/`

# Tasks: exclude-subagent-sessions-from-bridge

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 实现任务

- [x] `packages/dsh-adapter/src/session-id.ts`：新增 `isSubagentSession(session)`
      （读 `header.origin === 'subagent'`，形状容错，与 `sessionIdOf` 同风格）
- [x] `packages/dsh-adapter/src/index.ts`：`installBridge` 两个钩子开头早退；
      每个子会话首次出现打一行 `info`（跳过必须可观测，不静默丢弃）
- [x] `packages/dsh-adapter/tests/index.test.ts`：子会话不回传 / 不结算 / 主会话不受影响（新增 4 条）
- [x] 包内测试（73 passed）+ 全仓回归（常规 989 passed；E2E 5/5）+ `npm run build`（已核 dist 含新守卫）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 两处变更到 `openspec/specs/dsh-adapter/spec.md`（§2.5 替换 + §5 追加）
- [x] 更新 `openspec/specs/index.md`（dsh-adapter 行）
- [x] 登记 KI 到 `docs/KNOWN-ISSUES.md`（KI-18 extract 无校验 / KI-19 重复摘要）
- [x] 更新 `docs/HANDOFF.md`（本会话小结）
- [x] archive 到 `openspec/archive/2026-10-02-exclude-subagent-sessions-from-bridge/`

# Tasks: fulfill-privacy-mode

> 三处欠账一次补齐。见 `proposal.md`。

## 实现任务

- [x] `MemoryManager.ingest()`：`readonly` → payload 打 `skip_profile`
      （放在 PII 处理**之前**，让后者的 `{ ...payload }` 带着标记走）
- [x] `MemoryManager.setPrivacyMode(mode, sessionId?)`：记录 `privacySessionId`，留痕
- [x] `MemoryManager.resetPrivacyMode(sessionId?)`：**唯一实现**，返回布尔；按 `privacySessionId` 判是否恢复
- [x] `onSessionEnd()`：把内联的 `privacyMode = 'off'` 改成调 `resetPrivacyMode(sessionId)`
- [x] 新增 `packages/core/src/commands/privacy.ts`：`createPrivacyCommand()`
- [x] `commands/index.ts` 导出 + `modules/capabilities.ts` 注册（`/privacy`，别名 `/p`）
- [x] spec §4.6 重写（三档表格补 `skip_profile`、触发方式改单斜杠、三处欠账表、两条对账须知）

## 测试任务

- [x] 新增 `packages/core/tests/memory/unit/privacy-mode.test.ts`（11 例）
- [x] 关键三条：readonly **入库存档但打标记** / 别的会话结束**不清**本会话隐私 / 切换回执**说清"仍会存档"**
- [x] 全量 **162 文件 / 1911 用例**（Node 24）

## Apply 任务

- [x] 合并 spec 改动（`memory-system` §4.6）
- [x] 运行 `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`（memory-system 行「最后变更」）
- [x] 归档到 `openspec/archive/2026-10-25-fulfill-privacy-mode/`

## 明确不做

- ❌ console 的隐私开关 UI（产品决定，不属于"兑现承诺"）
- ❌ 改 `assembleMinimal`（当次不注入本来就是对的）
- ❌ 支持 `//privacy` 双斜杠（注册表按 `slice(1)` 解析；spec 已改单斜杠）

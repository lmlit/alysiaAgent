# Change Proposal: plan-synthetic-data-cleanup

## 元信息

- **日期**: 2026-10-20
- **类型**: DOC + 只读脚本（**不碰数据**）
- **status**: `applied`（方案就绪；**执行待人工**在服务器上做）
- **影响 spec**: 无（KI-20 的 spec 契约已存在）；补 `docs/KNOWN-ISSUES.md` 的残余条目指引
- **用户拍板**: 「先只出方案 + 备份脚本，不动数据」（2026-10-20）

## 这条要解决什么

`KI-20` 已修（新数据被 `skip_profile` + `synthetic` 挡住），但**存量从没清**：
线上约 **116 条** runtime-context 快照被当成用户消息入库，以及由它们产出的 facts。

它们的影响是持续的：污染画像、参与召回、可能进摘要。但**清理有判错风险**——
清错会让她忘掉真实的记忆。所以本 change 只交付**可执行的方案 + 只读工具**。

## 交付物

1. `docs/PLAN-2026-10-20-clean-synthetic-facts.md`
   —— 清什么/不清什么、执行前必须做的备份、人工复核用的 SQL、回滚、完成判据
2. `scripts/synthetic-data-audit.cjs`
   —— **只读**审计 + 文件级备份；用 `node:sqlite`（无需 better-sqlite3）

## 三个关键判断

**① events 不删。** Event Log 按定义**不可变**（KI-12 已立契约）。
删了会破坏审计链，还会让摘要窗口锚点（`getEarliestCreatedAt`）失真。

**② facts 作废而不是物理删。** 与 `memory-correction` 同款：
`status='superseded'` + `valid_until`，保留"曾经记过什么"。这次清理**可能判错**，
物理删不可逆。

**③ 摘要不自动重跑，交人工。** 含 synthetic 的会话里通常**也有真实发言**，
自动判定"整篇污染"会把真实内容一起丢掉。人工改写 `conversations.summary` 更安全。

## 脚本的安全设计

- 打开方式 `readOnly: true`
- `--backup` 只做**文件复制**（`db` / `-wal` / `-shm`），不执行任何 SQL 写
  （WAL 模式下必须连 `-wal` 一起备，否则备份可能缺最新提交）
- **删除/作废逻辑刻意不在脚本里** —— 留给人看着清单决定

## 自测（已做）

造了一个最小库（3 事件 / 2 facts）验证计数与分类：

```
事件总数: 3；其中 synthetic/skip_profile: 2
  - skip_profile_only: 1
  - runtime-context: 1
画像事实: 2 条；其中 source_event 指向 synthetic 事件: 1
涉及的会话数: 2
```

## 不做什么

- 不动任何数据（用户明确要求）
- 不给"一键清理"脚本（那会把判断变成默认值）
- 不改 `ingest.ts` 的过滤（已修，另案）

# Tasks: cut-dsh-memory-bridge

> 纯配置变更，无代码逻辑改动。方案 A（只切「写」），见 `proposal.md` §设计决策。

## 实现任务

- [x] **仓库源码**：`packages/dsh-adapter/cordis.patch.yml` → `alysia-adapter` 行 `config` 加 `bridge: false`
      （⚠️ bundle patch 的 `config` 是**整体替换**语义：已有的 `alysiaBaseUrl` 必须重述，不能只写新字段）
- [x] **安装副本 —— 不需要单独改**：`~/.dsh/profiles/{desktop,alysia-webtest}/node_modules/@alysia/dsh-adapter`
      都是 **Junction → `E:\workSpace\alysiaAgent\packages\dsh-adapter`**（已用 `Get-Item .LinkType` 验证），
      所以改仓库那处 = 两个 profile 同时生效。
      ★ 我起初误判成"实体拷贝、改仓库不生效"（依据是 `LinkTarget` 属性为空），**已更正** ——
      判据要用 `Get-Item <path> | Select LinkType,Target`，不是看 `LinkTarget`。
- [x] **spec**：`openspec/specs/dsh-adapter/spec.md` §2.5 补一行「当前部署该通道关闭（`bridge: false`）」
- [x] **文档**：`docs/PROMPT-INVENTORY.md` 路径 3（dsh）标注通道休眠；`docs/PLAN-2026-10-24` 加「方向变更」节
- [x] **文档**：`docs/TODO.md` 对应行改状态

## 验收任务（需重启 dsh）

> ⏳ **归档时这四项尚未执行** —— 2026-10-24 归档时用户还没重启 dsh。
> 保持 `[ ]` = **如实承认未验证**；**不要为了"归档要全勾"而假勾**。
> 重启后按序验，验完改 `[x]` 并在下面补一行结果。
> 重启后验证记录：（待填）

- [ ] **日志**：重启 dsh 后出现 `[alysia-adapter] 记忆通道已关闭（config.bridge=false）——只剩 recall_memory 工具`
- [ ] **库**：在 dsh 里聊几句 → `events` 无新增 `session_id LIKE 'dsh:%'` 行
- [ ] **反向**：`recall_memory` 仍可调用（只切了写）
- [ ] ⚠️ **重装检查**：`dsh plugin` 升级/重装会覆盖安装副本 ⇒ **重装后必须复查本开关**，
      否则通道会静默恢复。这条**永久有效**，不是一次性验收项

## Apply / 归档任务

- [x] 合并 spec 改动（已直接并入活 spec）
- [x] 运行 `node scripts/check-spec-diff-residue.cjs` → exit 0
- [x] 更新 `openspec/specs/index.md`（dsh-adapter 行「最后变更」）
- [x] 归档到 `openspec/archive/2026-10-24-cut-dsh-memory-bridge/`

## 明确不做

- ❌ 不清理历史数据（用户 2026-10-24：「已写入的就先不管了，问题不大」）
- ❌ 不删包、不禁用 preset、不改 `persona: xilian`、不动 `recall_memory`

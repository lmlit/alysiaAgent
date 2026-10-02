# Tasks: fix-role-import-wipes-persona

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 排查（证据链，非推测）

- [x] dsh 读通道返回 0 字 → 先怀疑读通道本身
- [x] 查库：生产 `persona.system_prompt` 长度 **0**（读通道没坏，是数据空）
- [x] `getActiveSystemPrompt()` → `personaStore.get().system_prompt`，确认取值路径
- [x] 读 `importRole` → `system_prompt: pkg.system_prompt ?? ''`
- [x] 读 `upsertRole` → **整行 UPDATE**（`SET name=?, tone=?, …, system_prompt=?`）
- [x] 查两个角色包 → `role: "alysia"` 且**无 `system_prompt` 字段**
- [x] **天然对照**：隔离 dataDir 启动（无 `roles/`）→ 6375 字 ✓ 因果闭合
- [x] 发现影响面更大：`tone` 等列也被冲，只是 `PersonaStore.get()` 会自动填默认值掩盖了

## 修复

- [x] `MemoryManager.importRole`：改为**按字段合并** ——
      包提供了就用包的；否则保留已有；都没有才落默认
- [x] 覆盖 `system_prompt` / `tone` / `speech_style` / `emotional_range` / `memory_config`
- [x] 不写数据迁移脚本（`seedPersona` 每次启动都跑，修好后重启即自愈）

## 测试

- [x] `tests/memory/unit/import-role-merge.test.ts`（6 用例）
      - ★ 表情包形状的包（只带 worldbook）→ **persona 字段逐字不变**
      - ★ 包只提供部分字段 → 只覆盖它提供的那个
      - 包显式提供 `system_prompt` → 应当覆盖（角色包的正常用途）
      - 显式空串也算「提供了」（不被已有值挡住）
      - **新 role（无既有行）仍落默认值** —— 别把新建路径改坏
      - 不影响 worldbook 导入（别误伤另一半）

## 验收（2026-10-01，真启动实测）

| 项 | 修复前 | 修复后 |
|---|---|---|
| 生产库 `system_prompt` | **0 字** | ✅ **36351 字** |
| `persona.tone` | 55 字节（结构默认值） | ✅ **59 字节（她的真实调校）** |
| `GET /api/persona/prompt` | 0 字 | ✅ **6375 字 / 4 节** |
| 启动日志 | `Role package loaded` ×2 | ✅ 相同（导入照常，只是不再冲掉人设） |
| 常规全仓 | 883 | ✅ **889 passed**（+6 回归） |

## Apply 任务

- [x] `docs/Web-API-Design.md`：`POST /api/roles/import` 补「未提供字段不覆盖」的语义
- [x] `openspec/specs/role-system/spec.md`：补字段合并语义
- [x] `openspec/specs/index.md` 更新
- [x] `docs/HANDOFF.md`

## ⚠️ 需要注意的行为变化

修好后她的人格核心（36KB，`compactPersona` 取前 4 节约 **6.4KB**）
**第一次真正进入 system prompt**。

- 这**是设计意图**（那份文件就是"她是谁"），但意味着**她的回复风格会有可见变化**——
  之前她靠世界书（101 条背景设定）撑着角色感，现在人设核心也在场。
- context 开销：每轮多 ~6.4KB（此前是 0）。
- 建议观察几天；若觉得人设过重压过了世界书，可调 `getCompactPersonaPrompt(n)` 的节数。

## 遗留

- 同族 bug 的**第三次普查**：坑 #7 修了「世界书被 `DELETE WHERE role=?` 误删」，
  本次修了「persona 被空默认值覆盖」。**`importRole` 里还有没有别的「空默认覆盖」？**
  已通读一遍：worldbook 的 digest 保留逻辑（8-27）是对的，其余字段都在本次覆盖范围内。

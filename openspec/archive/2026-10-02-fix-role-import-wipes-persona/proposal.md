# Change Proposal: fix-role-import-wipes-persona

## 元信息

- **日期**: 2026-10-01
- **类型**: FIX
- **状态**: archived（2026-10-02 完成，2026-10-02 补归档；apply 已合并回 `openspec/specs/`）
- **影响 spec**: `role-system`（importRole 的写入语义）、`memory-system`（人格注入）
- **发现于**: dsh 读通道验证（`GET /api/persona/prompt` 返回 0 字）

## 动机（为什么做）

**昔涟的人格核心从未进入她的 system prompt。每次启动都被清空。**

### 证据链（已闭合）

| # | 证据 |
|---|---|
| 1 | 生产库 `persona.system_prompt` 长度 **0**，`updated_at` = 最近一次启动 |
| 2 | **天然对照**：隔离 dataDir 启动（该目录下**没有 `roles/`**）→ 读通道返回 **6375 字** |
| 3 | 两个表情包角色包 `data/roles/stickers*.json` 都是 `role: "alysia"`，且**没有 `system_prompt` 字段** |
| 4 | `importRole` 第 1494 行：`system_prompt: pkg.system_prompt ?? ''` → 覆盖成空串 |
| 5 | `upsertRole` 是**整行 UPDATE**（`SET name=?, tone=?, …, system_prompt=?`） |

### 触发路径

```
al:persona-seed 模块 apply：
  1. seedPersona()      写入 soul.md 的完整人设
  2. seedWorldbook()
  3. loadRolePackages() ← 导入 stickers-role.json / stickers.json（role 均为 'alysia'）
                        ← upsertRole 用「包没提供的字段 → 空默认值」整行覆盖
```

### 影响面比 `system_prompt` 更大

`tone` / `speech_style` / `emotional_range` **同样被冲**，只是
`PersonaStore.get()` 检测到空值会**自动填回结构默认值**（读出来 55 字节，
看着像没坏，其实是默认参数不是她的真实调校）。`system_prompt` 没有这种兜底，
所以只有它表现出「空」。

**为什么她听起来还是昔涟**：世界书（101 条，含 `Cyrene.md`/`characters.md`/`world.md`）
在撑着角色感——但那是**背景设定**，不是「她是谁、她怎么说话」的那份核心文件。

> 与 `docs/dsh-migration-guide.md` **坑 #7 同族**：那次修的是
> 「`DELETE WHERE role=?` 误删世界书」，**persona 这半没修**。

## 需求（做什么）

- [ ] `importRole` 不再用「空默认值」覆盖包**未提供**的字段——保留已有值，无已有值才落默认
- [ ] 覆盖范围：`system_prompt` / `tone` / `speech_style` / `emotional_range` / `memory_config`
- [ ] 回归测试：导入一个「只有 role+name+worldbook」的包（**就是表情包包的形状**）后，
      目标 role 的 persona 字段**逐字不变**
- [ ] 实测：重启服务 → 生产库 `system_prompt` 恢复非空、读通道返回完整人设

## 设计决策

**决策 1：取「按字段合并」而不是「整包跳过」**

备选是「包没有 `persona` 块就完全不碰 persona 行」。
否决原因：那样「包**部分**提供 persona」时仍会冲掉其余字段。
按字段回退（`pkg.X ?? existing.X ?? 默认`）覆盖所有情形，代价只多一次 `getByRole` 读。

**决策 2：修完不写数据迁移脚本**

`seedPersona` **每次启动都跑**，修好后它写入的人设不会再被覆盖——
重启即自愈。存量库无需单独回填。

**决策 3：不顺手改 `seedPersona` 的调用顺序**

把 `loadRolePackages` 挪到 `seedPersona` 之前是「绕过」不是「修复」，
且会让角色包与 seed 的优先级关系变得依赖顺序。修根因。

## 对账方向确认

- [x] 与现有 spec 冲突？`role-system` 未规定「包未提供字段」的语义 → 本 change 补上，**改 impl 也补 doc**
- [ ] `docs/Web-API-Design.md`：`POST /api/roles/import` 行为变化，需补一句语义说明

## 测试计划

- 单测：只有 worldbook 的包 → persona 字段不变；提供部分字段的包 → 只覆盖提供的
- 单测：新 role（无已有行）→ 落默认值（**别把新建路径改坏**）
- 回归：常规全仓 + E2E
- 实测：真启动 → 查库 `system_prompt` 非空 + `GET /api/persona/prompt` 返回完整人设

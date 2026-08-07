# Change Proposal: worldbook-sampling-cooldown

## 元信息

- **日期**: 2026-08-07
- **类型**: MODIFY（补实现）
- **状态**: pending（backlog——治理对账登记，暂不实现）
- **影响 spec**: ai-life-system（§6/§7 世界书采样）

## 动机（为什么做）

治理对账（2026-08-07）发现：ai-life-system spec §6/§7 声明世界书采样
"priority 加权 + cooldown 过滤"，但实现（`MemoryManager.getWorldbookSample`）只做
`ORDER BY priority DESC`，**无 cooldown 过滤**。hit_count 统计已实现（bumpWorldbookHit），
cooldown 一半契约缺失。

按对账规则（doc 已声明 impl 没接 → 改 impl 不改 doc），此 gap 保留 spec 原文，
以本 change 记录在案。

## 需求（做什么）

- [ ] `getWorldbookSample` 增加冷却过滤：近期（如 6h 内）命中过的条目降权或跳过
- [ ] 与 `bumpWorldbookHit`（hit_count+1）配合，避免同一世界书条目反复注入事件生成器
- [ ] 加测试

## 设计决策

未定（实施时再决策：冷窗口时长、是跳过还是降权、是否读 worldbook 表的 last_trigger 字段）。

## 对账方向确认

- [x] 与现有 spec 冲突 → 本 change 是补实现（doc → impl 方向，spec 不改）

## 测试计划

- getWorldbookSample 冷却期过滤单元测试

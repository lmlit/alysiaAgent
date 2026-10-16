# Change Proposal: worldbook-sampling-cooldown

## 元信息

- **日期**: 2026-08-07（**2026-10-16 落地并归档**）
- **类型**: MODIFY（补实现）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `ai-life-system` §6（采样方式 + 冷却语义）

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

实施时的决策（原为"未定"）：

**决策 1：跳过（过滤掉），不降权。**
理由：对话触发路径（`WorldbookStore.match`）本来就是**跳过** ⇒ 两路径语义一致；
且"降权"仍会把同一条递给她，解决不了「反复注入事件生成器」。

**决策 2：冷窗口 = `max(6h, 条目的 cooldown_sec)`，不只用条目自带的。**
条目默认 `cooldown_sec = 300`（5 分钟），而事件生成器是**每小时** tick
（间隔 0.5~8h，默认 1h）⇒ 5 分钟冷却在小时级节奏上**等于没有**。
取 6h 是因为生成器绝大多数间隔 ≤ 6h。
取 **max** 则让「条目显式声明的更长冷却」在两个路径上都生效 ——
这样 `bumpWorldbookHit()` 注释里那句「与对话触发**共用冷却**」才是真的。

**决策 3：读 `worldbook_entries.last_triggered`（不新增字段/不做历史表）。**
写入侧 `recordTrigger` 早就在写它，缺的只是读取侧看一眼。

**决策 4：不新增配置旋钮、不改 schema。**
实测 `last_triggered` 非空的条目**只有 2 条**（95 条里）⇒ 这是**契约缺口**而非事故，
修法取最小。（要按运行数据调窗口时再立 change。）

## 对账方向确认

- [x] 与现有 spec 冲突 → 本 change 是补实现（doc → impl 方向，spec 不改）

## 测试计划

- getWorldbookSample 冷却期过滤单元测试

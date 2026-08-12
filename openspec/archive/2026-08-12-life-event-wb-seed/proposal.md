# Change Proposal: life-event-wb-seed

## 元信息

- **日期**: 2026-08-12
- **类型**: FEATURE（ai-life 二期④：世界书 life_event 种子）
- **状态**: archived
- **影响 spec**: ai-life-system（二期④ / §7 世界书关联）

## 动机

角色世界书条目 content_type='life_event'（事件模板种子）被 getWorldbookSample
过滤掉（只取 text）——角色专属事件设定（如"昔涟会去集市买桃子"）进不了
事件生成上下文，生成的事件偏离角色。

## 需求

getWorldbookSample SQL：`content_type = 'text'` → `content_type IN ('text', 'life_event')`
——life_event 种子与文本条目按 priority 同池采样（角色专属种子 priority 高则自然优先）。

## 测试

- life_event 条目被采样且按 priority 排前
- 全量回归

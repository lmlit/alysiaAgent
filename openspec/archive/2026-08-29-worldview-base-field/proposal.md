# Change Proposal: worldview-base-field

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `ai-life-system` + persona 文件

## 动机
底色/世界观散落三处(identity.md / daily_life 采样 / life.ts 硬编码),改一处漏一处。统一为"一个字段,每轮注入"——聊天与事件生成从同一数据源取。

## 需求
- [ ] 新建 `persona/worldview.md`(集中底色:跨世界之窗 + 独立人格 + 生活中心)
- [ ] loader PERSONA_FILES 加入 worldview.md(聊天 system prompt 自动注入)
- [ ] MemoryManager.getWorldviewBlock():读 worldview.md(缓存)——事件生成注入
- [ ] life.ts【隔着世界】硬编码 → 改为调 getWorldviewBlock()
- [ ] identity.md 跨世界段移入 worldview.md(去重)

## 对账
- [x] 不涉及 Web API

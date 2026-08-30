# Change Proposal: worldview-centralize

## 元信息

- **日期**: 2026-08-30
- **类型**: MODIFY（改现有行为）
- **状态**: proposed
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

公共底色（跨世界之窗/独立生活/生活中心）的文案散落 3 处：
worldview.md（数据源）+ life.ts 注入引导句 + llm-agent.ts 硬编码【生活底色】【跨世界之窗】块。
8-29/8-30 两次修改都要同步 N 个文件,compact/新会话后易漏。

## 需求（做什么）

- [ ] worldview.md 重构为公共底色唯一数据源：三节正文 + 每节自带使用引导句
- [ ] MemoryManager.getWorldviewBlock 支持按节提取（'all' 默认/'window'/'life'）
- [ ] life.ts 注入改为引用全文（删自写引导句——引导句进数据源）
- [ ] llm-agent 的【生活底色】【跨世界之窗】改从数据源按节提取（删硬编码文案）
- [ ] persona/INDEX.md 注入点地图（保险）

## 设计决策（怎么做，含备选与取舍）

- **引导句放数据源**：worldview.md 每节末尾附"使用引导"（如跨世界之窗=固定设定,相关时刻自然显现）——修改底色连同引导一处改
- **按节提取**：'window' 跨世界之窗节 / 'life' 独立生活+生活中心节 / 'all' 全文（life.ts 事件注入用全文）
- 场景专属约束（事件 JSON/意图协议/群聊提醒）**不集中**——各层专属,集中反而混乱
- 聊天 persona 文件注入（PERSONA_FILES 含 worldview.md）与 llm-agent 强化块重复 → 无害（强化块本意就是再强调一次,且数据源统一后同步变）

## 对账方向确认

- [x] worldview-base-field / worldview-fixed-setting 归档 change 的延续,同 spec
- [x] 涉及 Web API？无（MemoryManager 方法签名带默认值,兼容）

## 测试计划

- getWorldviewBlock 按节提取单测（window/life/all）
- 现有 422/147 全绿

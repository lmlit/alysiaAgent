# Change Proposal: life-template-self-classify

## 元信息

- **日期**: 2026-08-27
- **类型**: FIX（补实现 gap）
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

8-14 起昔涟可通过 `add_life_template` 自写生活模板（source='self'）。8-27 模板扩容加了 `category`（独处/互动/分享）+ `group_name`（角色分组），但**自加路径没接分类**——`addLifeTemplate` 不传 category/group_name，DB 默认值兜底，自写模板固定"独处/none"。

后果：
1. 昔涟自写"互动"类模板（如"迷迷趴在我肩上睡着了"）回落时**匹配不到在场角色组**（group_name='none' 被排除在 groupPool 外）
2. 分类统计/Web 展示不准确

## 需求（做什么）

- [ ] `add_life_template` 工具参数加 `category`（独处/互动/分享）+ `group_name`（none/迷迷/风堇/遐蝶/白厄/其他人），LLM 自行判断（活动涉及其他角色→互动+对应角色；想分享给轻月→分享；否则独处）
- [ ] `MemoryManager.addLifeTemplate` 透传 category/groupName；未传时按 type 默认映射（chat→分享、internal→独处）
- [ ] `LifeStore.addTemplate` INSERT 带 category/group_name

## 设计决策（怎么做，含备选与取舍）

| 决策点 | 结论 | 备选（否决理由） |
|--------|------|------------------|
| 分类来源 | 工具参数由 LLM 填（活动内容决定分类，LLM 最懂） | 校验器 LLM 返回分类（多一次往返，且校验器 prompt 已固定） |
| 默认映射 | 未传 category → chat→'分享'、internal→'独处'（向后兼容旧调用） | 全默认'独处'（chat 类分享模板会被误归类） |
| group_name 校验 | 互动类未给 group_name → 'none'（不硬性要求，防误报） | 强制必填（LLM 可能乱填，宽松更稳） |

## 对账方向确认

- [x] 与现有 spec 不冲突——8-27 分类列已声明，本 change 补自加路径实现
- [x] 涉及 Web API？addLifeTemplate 入参扩展（纯增量，可选字段），对照 `docs/Web-API-Design.md` 后无需改契约

## 测试计划

- 单元：addLifeTemplate 传 category/groupName 落库；未传默认映射（chat→分享、internal→独处）
- 回归：`npx vitest run` 全绿

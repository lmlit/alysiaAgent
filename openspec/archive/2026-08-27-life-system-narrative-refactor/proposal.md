# Change Proposal: life-system-narrative-refactor

## 元信息

- **日期**: 2026-08-27
- **类型**: MODIFY（改现有行为）
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

当前生活系统是"定时独立事件生成器"：事件内容突兀、全是独处（internal 占比过高）、世界书采样不相关、推送判定只看冷却+上限、缺乏时间连续性和角色状态。

参考 HDS-Interlude（幕间系统）的五大机制（持续叙事 / 配角在场 ScenePresence / 情绪惯性 Alter / Agency Window / 对话后续 conversation-follow-up），在现有架构上增量改进——**不照搬、不引入 Koishi 依赖、不写 5000 行 service**。

核心理念：我们要的不是更多的事件模板，而是让事件从角色的生活中自然生长出来。

## 需求（做什么）

### P0
- [ ] 配角在场状态：新建 `ai_life_scene_presence` 表，事件生成时注入在场角色，LLM 不能凭空召唤离场角色
- [ ] 情绪惯性：`ai_life_state` 加 mood_value 累积字段，同方向加成、反方向衰减、8h 回归 0，注入 context 影响事件风格
- [ ] 模板扩容：8 条 → 40+ 条，分独处/互动/分享三类，按角色关系分组（迷迷/风堇/遐蝶/白厄/其他人）
- [ ] 世界书分层随机：`getWorldbookSample()` 改为 life_event 取 3 + text 取 2，随机抽取，截断 200 字
- [ ] 新建 `daily_life.md`：10-15 条 `content_type='life_event'` 生活化世界书条目（住所/饮食/爱好/习惯/童年）
- [ ] system prompt 加 9 条约束：活动范围/生活气息/不是一个人/不硬复述设定/chat 是分享不是报备/不引用对话/注意当前心情（+时间线、第一人称已有）
- [ ] post-check 7 条校验：长度/不硬设定/对话感/不重复/不连续独处/不引用对话/不在场角色不出现

### P1
- [ ] Agency Window：事件生成时 LLM 返回 `agency.can_contact`，推送判定改为角色当前是否方便联系（不只是冷却+上限）
- [ ] 对话后续：聊完天 15min 后生成 internal"对话余波"事件，不推送只记录

## 设计决策（怎么做，含备选与取舍）

| 机制 | HDS-Interlude 做法 | 本 change 简化做法 |
|------|-------------------|-------------------|
| 配角在场 | 压缩时 LLM 更新 presence（最多 8 项，须引用真实剧本条目） | 事件生成后自动推导：事件内容提到谁 → 在场；24h 无提及 → off-scene。**不做** LLM 更新回路（简单可测） |
| 情绪惯性 | alter 评分 -5..+5 累计 + 动态阈值 + 侧端分析生成 emotionalOffset | mood_value 直接累积（同向加成/反向衰减/8h 回归 0），注入【心情】块；**不做**侧端分析（mood_value 本身即 prompt 可见） |
| Agency Window | activityLoad/privacy/deviceAccess 三维 + 容量矩阵 + recheck-later | 事件 JSON 带 `agency.can_contact`，推送门加一条件；**不做**重查队列（保持推送判定简单） |
| 对话后续 | 对话结束锚定 10/20min 短程回合，rest window 抑制 | 最后 user 消息 15min 后无余波 → 生成 internal 余波事件；**不做**多档位（单次即可） |
| 模板 | — | 表加 category/group 列，40+ 种子；模板仍是回落保底，LLM 生成是主路径 |

**迁移原则**：全部 `ALTER TABLE ... ADD COLUMN` + try-catch（沿用 database.ts 现有 v2/v3 迁移模式），**不 DROP 任何表**，现有数据不丢。

**core 接口约束**：MemoryManager 只加方法不改签名；`getLifeSnapshot()` 返回值**增加** moodValue/scenePresence 字段（纯增量，Web 端兼容）。

## 对账方向确认

- [x] 与现有 spec 不冲突——本次是 spec 声明的实现层增量改造，apply 时把新机制并入 `ai-life-system/spec.md`
- [x] 涉及 Web API：`getLifeSnapshot` 返回字段增量扩展（moodValue），对照 `docs/Web-API-Design.md` 后处理

## 测试计划

- 单元：mood_value 同向加成/反向衰减/8h 回归、post-check 7 条规则、在场推导（事件提到谁→present）、模板分组加权
- 单元：getWorldbookSample 分层随机（life_event 3 + text 2、200 字截断）
- 集成：life.ts 生成流程（mock generateEvent）——在场注入/心情注入/can_contact 推送门/余波调度
- 回归：`npx vitest run --exclude='tests/memory/e2e/*'` 全绿

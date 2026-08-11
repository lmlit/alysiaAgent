# Change Proposal: profile-transient-expiry

## 元信息

- **日期**: 2026-08-12
- **类型**: FIX（时效性信息固化进长期画像）
- **状态**: pending
- **影响 spec**: memory-system（画像事实提取与过期）

## 动机（为什么做）

用户反馈 + 线上实锤（8-11 日志）：

```
[04:30] 昔涟: 午安，轻月。…香菜拌牛肉配煎蛋很下饭吧？…
[04:31] 轻月: 香菜牛肉已经是我几百年前吃的午餐了
```

"午餐吃了香菜拌牛肉"这类**瞬时事件**被 ProfileExtractor 提成 confidence 1.0
的 active fact 永久固化（valid_until=null）→ getUserActivitySummary 按
confidence 取 top5 注入问候 prompt → bot 引用过期午餐。

根因：提取 prompt 无时效性分类要求；schema 的 valid_until/过期机制
（ProfileStore.getActiveFacts 已过滤 valid_until > now）**设计完备但从未接线**。

## 需求（做什么）

1. **提取 prompt 加时效性分类**：LLM 对每条事实输出 `transient: true/false`
   - 稳定属性（城市/职业/习惯/偏好/关系/身体状况/长期爱好）→ false
   - 时效信息（某天饮食/当天状态/单次事件/梦境/近期近况）→ true
2. **接线过期**：transient=true → `valid_until = now + 48h`，到点自动过期
   （getActiveFacts 自动过滤）→ 不再进"用户近况"，问候不再引用
3. **存量清洗**：线上 194 条 facts 一次性 LLM 分类，transient 的补 48h
   过期（先备份 DB）

## 设计决策

- 提取时分类（根治源头）+ 48h 自动过期（自然衰减）——不搞关键词黑名单
  （易误伤"不喜欢吃香菜"这类稳定偏好）
- transient 判定的 48h 窗口：够"近况"用，够短不残留
- 存量清洗用独立脚本 + DB 备份，不依赖新代码上线

## 对账方向确认

- [x] impl 缺陷（提取无时效分类）→ 本 change 记录修复，spec 同步更新

## 测试计划

- ProfileExtractor：transient=true → valid_until ≈ now+48h；false → null
- 存量清洗脚本：dry-run 输出分类统计
- 既有测试回归

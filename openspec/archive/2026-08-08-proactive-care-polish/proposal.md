# Change Proposal: proactive-care-polish

## 元信息

- **日期**: 2026-08-08
- **类型**: MODIFY（行为增强）
- **状态**: in-progress（用户确认实施）
- **影响 spec**: proactive-messages（§2.1.5 上下文注入 / §3 主动关怀）

## 动机（为什么做）

8-08 服务端优化盘点，用户确认实施两项：

1. **关怀文案未走 LLM 个性化**：问候（greeting）与节日祝福都过 `personalize()`（LLM
   生成、失败回落写死文案），唯独主动关怀分支用写死文案池 `CARE_MESSAGES[random]`
   （proactive.ts `tick()`）——体验不一致，且关怀无法参考用户近况/生活事件。
2. **contextSnippet 生活事件素材语义偏差**：`listLifeEvents(2)` 的入参是**天数**
   （MemoryManager 签名 `listLifeEvents(days: number = 7)`），当前实现取"最近 2 天"
   再过滤今天——跨午夜边缘可能带上昨天的事件，且 intent 是"我今天的日常"却扫了
   两天窗口。改为 `listLifeEvents(1)` + 按今天日期过滤。

## 需求（做什么）

- [x] `tick()` 关怀分支：`CARE_MESSAGES` 随机 → `personalize()`（LLM 生成轻量关怀文案，
      失败回落随机池子；prompt 强调"轻松、不追问、不制造回复压力"）
- [x] `contextSnippet()`：`listLifeEvents(1)` 过滤 `localDateKeyFromISO(createdAt) === today`，
      `slice(-3)` 保持
- [ ] 加测试：关怀分支调用 generateText（mock）；contextSnippet 过滤跨天事件

## 设计决策

- 关怀 prompt 引用 `contextSnippet()` 素材（与问候一致），但注明"不要生硬引用"（复用既有文案）
- 失败路径不变：`personalize` 内部 try/catch，回落池子文案

## 对账方向确认

- [x] 无 spec 冲突——本 change 是对已声明行为的增强（spec 随 change 更新 §3 关怀小节）

## 测试计划

- proactive.test.ts：关怀触发时 generateText 被调用且文案来自 LLM；contextSnippet 混入非今天事件时只取今天的

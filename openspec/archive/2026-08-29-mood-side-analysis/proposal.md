# Change Proposal: mood-side-analysis

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机
情绪惯性只有极性数字(mood_value),无 HDSI Alter 侧端分析的"描述性氛围"。缺"这段日子偏忧郁"的叙事感。

## 需求(简化落地)
- [ ] mood_value 累积达到深度阈值(|mv| ≥ 30)且 6h 内未分析 → 触发侧端分析:LLM 根据最近事件+情绪轨迹生成一句氛围描述("这段日子…")→ 存 ai_life_state.mood_note(新列)
- [ ] 【心情】块升级:极性 + mood_note(注入对话 system prompt 与事件生成 context)
- [ ] 失败不阻塞(冷却后重试);mood_value 回落到 |mv| < 30 → 清空 mood_note

## 对账
- [x] spec 情绪惯性节更新;涉及 Web API(getLifeSnapshot 加 moodNote)

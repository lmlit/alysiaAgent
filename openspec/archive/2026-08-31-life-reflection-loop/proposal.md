# Change Proposal: life-reflection-loop

## 元信息

- **日期**: 2026-08-31
- **类型**: NEW（新功能）
- **状态**: proposed
- **影响 spec**: `ai-life-system`

## 动机（为什么做）

人的架构中最核心的部分是**自修改的执行器**——经历后反思、"下次不这样了"，改写自己的处理方式。
当前系统：L1 状态转移（输入→状态）完整；L2 参数级转移函数（情绪漂移/5 道护栏）运行中；
**L3 规则级缺失**——mood_note 有反思但输出只进状态，没有回写处理逻辑。

## 需求（做什么）

- [ ] **每日反思闭环**（LifeService，独立冷却 reflectionDate）：
  输入（今日事件流 + mood + persona 快照 + 近 3 天摘要）→ LLM 生成
  `{ reflection, adjustments[], insight? }` → 回写：adjustments 走 5 道护栏调人格参数 /
  insight 进 profile facts / reflection 存 ai_life_state
- [ ] 护栏：delta 钳制 ±0.05（反思是慢变量，比实时 0.1 更保守）/ ≤3 条 / reason 必填
- [ ] 迁移：ai_life_state 加 reflection 列（ALTER + try-catch，不 DROP）
- [ ] MemoryManager.recordReflection 收口（命名规范 record*，同 recordLifeEvent）

## 设计决策（怎么做，含备选与取舍）

- **频率每日一次**（跨天冷却,失败静默次日重试）——反思周期=一天,和每日摘要同节奏
- **输入含 persona 快照**：LLM 需要知道当前参数才能建议调整（"从现在的样子变得更…"）
- **insight 走 profile facts 冲突检测**（addFacts 去重）——"我悟到的"是画像事实的一种
- **reflection 存 ai_life_state**（WebUI 可读）；冷却存 life-state.json（reflectionDate,同 lastSummaryDate 模式）
- adjustments 应用失败（护栏拦截）→ 记日志不阻断（insight/reflection 照常入库）

## 对账方向确认

- [x] ai-life-system spec 无反思机制 → 新增
- [x] 涉及 Web API？recordReflection 是 core 公开方法（record* 命名,同 recordLifeEvent）——WebUI 无立即需求,契约文档登记

## 测试计划

- mock LLM：adjustments 应用（护栏内）/ 拦截（超限）/ insight 入库（去重）/ reflection 存 state
- 冷却：同日不重复触发；失败不置位可重试
- 迁移：旧库 ALTER 后 reflection 列可用

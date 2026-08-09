# Change Proposal: ai-life-event-driven-scheduling

## 元信息

- **日期**: 2026-08-09
- **类型**: MODIFY（ai-life 二期）
- **状态**: in-progress（用户确认方案 C + 分段发送）
- **影响 spec**: ai-life-system（§5 调度 / §6 事件生成 / §10 推送）+ qq 适配器（分段）

## 动机（为什么做）

用户产品思路：LifeService 从"定时器+概率"升级为"**事件驱动的时间状态机**"——
事件内容影响下一次触发时间（"玩游戏"→ 沉浸 3h 后再来新事件），剧情可从上一事件
延续或自然分支。8-09 用户确认方案 C（时间自由 + 剧情延续 + 状态持久化）+ 长句
分段发送（实时陪伴感）。LLM 二次切分方案（更耗 token）记录为后续候选。

## 需求（做什么）

### 调度（决策 1/4/5）
- [x] `next_in_hours`（0.5-8 钳制）：事件 JSON 建议下次间隔，服务端精确到点调度
      （setInterval → nextEventAt + setTimeout，与问候调度器同风格）
- [x] `nextEventAt` 持久化到 state.json——重启重排**不补发**（错过即错过）
- [x] 移除概率门（不确定性由 next_in_hours 承担）；保留聊天锁/深夜抑制

### 剧情延续（决策 2）
- [x] `continuation_of`：最近 8h 内 internal 事件 + 最近 30min 无用户互动 → 注入
      【你正在做的事】块（可延续）；LLM 选择延续或新事件（防幻觉：id 须命中今天事件）
- [x] 用户互动后重置沉浸（聊天锁命中 → 不注入延续块）

### 推送节奏（决策 3 + 分段）
- [x] chat 冷却 2h → 1h；**每日软上限**（默认 5 条，超限降级 internal 照常入库不推送）
- [x] 长句分段发送：sendProactive 自动分段（标点切分 ≤40 字/段、段间 500-900ms、
      任一段失败立即中断、≤3 段）；>60 字才触发，短文案行为不变
- [x] generateEvent prompt 加切分友好约束（句号自然断句）+ schema 扩展

### 附注
- [ ] LLM 二次切分方案（用户思路）——本轮不做，记录：token 成本 + 与代码切分效果对比
- [ ] 测试：segmentText 单测 + 调度/延续/软上限 + 旧用例适配（概率门移除）
- [ ] spec：ai-life-system §5/§6/§10 合并

## 设计决策

- 间隔数字直给 + 服务端钳制（30min-8h）；LLM 未给 → 默认 2h ± 30min 抖动
- 延续注入条件：8h 内 internal 事件（查库，不新增 state 字段）+ 30min 无用户互动
- 软上限跨天重置（挂在 maybeGenerateDailySummary 的跨天检测上）
- 分段上限 3 段、尾部碎段并入上段、表情包标记不受影响（文本段发完再发图片）

## 对账方向确认

- [x] 与 ai-life-system spec §5（每小时 tick）/§10（推送冷却）有行为变更——spec 随 change 更新

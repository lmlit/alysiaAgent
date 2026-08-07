# Change Proposal: memory-knobs-into-recall-pipeline

## 元信息

- **日期**: 2026-08-07
- **类型**: MODIFY（补实现）
- **状态**: pending（backlog——治理对账登记，暂不实现）
- **影响 spec**: memory-system（§4.3 记忆人格联动 v2）

## 动机（为什么做）

治理对账（2026-08-07）确认：memory-system spec §4.3 "记忆人格联动 v2" 声明
PersonaAdapter 输出 memory_config 旋钮增量（retention_bias / decay_rate /
importance_threshold / recency_weight / confirmation_bias），意图是旋钮**驱动记忆
存取的筛选/衰减**。但实现中旋钮的唯一消费者是 LifeService 亲密度（2026-08-07 接线，
change: wire-memory-config-knobs）——**召回/遗忘管道（EventStore 检索、PromptAssembler
注入、MemoryManager.read）零消费**。旋钮仍半空转。

按对账规则（doc 已声明 impl 没接 → 改 impl 不改 doc），此 gap 保留 spec 原文，
以本 change 记录在案。

## 需求（做什么）

- [ ] `retention_bias` 接入：检索结果排序/注入时正负偏向（+1=只记好）
- [ ] `decay_rate` / `importance_threshold` 接入：事件检索权重随年龄/重要性衰减
- [ ] `recency_weight` 接入：近期 vs 远期检索权重
- [ ] `confirmation_bias` 接入：画像/人格更新响应度（暂只用于亲密度平滑）
- [ ] 加测试

## 设计决策

未定（实施时决策：旋钮作用在检索权重而非过滤——避免硬切断；每旋钮先接一处消费点）。

## 对账方向确认

- [x] 与现有 spec 冲突 → 本 change 是补实现（doc → impl 方向，spec 不改）

## 测试计划

- 旋钮值变化 → 检索结果排序/权重变化断言

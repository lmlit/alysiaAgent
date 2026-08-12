# Change Proposal: memory-knobs-into-recall-pipeline

## 元信息

- **日期**: 2026-08-12
- **类型**: FEATURE（记忆旋钮接线，召回管道零消费 → 生效）
- **状态**: archived
- **影响 spec**: memory-system（§4.3 旋钮语义 → 召回接线）

## 动机

Backlog 挂起项：旋钮（decay_rate/importance_threshold/recency_weight/...）
只被 PersonaAdapter 喂给 LLM 调整数值，召回/遗忘管道零消费——改数值不影响
任何行为（半空转）。用户确认实现。

## 需求

1. `read()` 三路检索（vector 主路径 + 两处 text fallback）排序前应用
   `applyKnobsToRetrieved`：decay_rate（半衰期 24h/decay）、recency_weight
   （时间惩罚上限 50%×ageFactor）、importance_threshold（metadata.importance
   > threshold 加分 0.15）
2. 会话向量 metadata 补 updated_at（事件向量已有 created_at）
3. `MemoryManager.adjustMemoryConfig / getMemoryConfig` 公开（Web 契约）

## 设计决策

- 公式可解释：半衰期模型 + 线性惩罚上限；知识库（无时间）天然不衰减
- importance_threshold 数据依赖：服务端 ingest importance 恒 0——加分
  逻辑已接好，importance 计算接入后自动生效（如实接线不空转）
- retention_bias/confirmation_bias（存储/提取情感偏向）需情感/importance
  计算支持，本轮不接（spec 注明后续）

## 测试

- recency_weight=1：3 天前高分事件被罚后低于新事件；知识不衰减
- decay_rate=0：不罚，相关度排序保持
- importance > threshold：加分提前

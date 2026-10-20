# Tasks: wire-retention-bias-into-recall

## 数据源（先做）

- [x] `moodDeltaToPolarity()`：数值取符号 / 正负词表 / 判不出返回 0
- [x] 强度表（arousal）保持不动 —— **两轴不合并**，注释写清理由
- [x] `recordLifeEvent` 把 `polarity` 写进向量 `metadata`（只对新事件）

## 接线

- [x] `applyKnobsToRetrieved`：`score × (1 + retention_bias × polarity × RETENTION_BIAS_IN_RECALL)`
- [x] 常量 `RETENTION_BIAS_IN_RECALL = 0.1`（初版 0.3 被测试否掉，理由写进注释）
- [x] `polarityAdjusted` 计数贯通 `applyKnobsToRetrieved` → `mergeWithQuota` → `[Recall]` 日志

## 测试

- [x] `moodDeltaToPolarity`：数值 / 负向词 / 正向词 / 中性词 / 判不出（0）
- [x] 存量无 `polarity` ⇒ 排序与计数都不变（**不追溯**）
- [x] `retention_bias = 0` ⇒ 计数 0（可关闭）
- [x] 正 bias → 好的在前；负 bias → 坏的在前
- [x] ★ **幅度保守**：0.9 的强匹配不许被 0.8 的偏好记忆翻掉
- [x] 全量：**140 文件 / 1755 测试全绿**

## Spec

- [x] §3 ⑦：`retention_bias` 已接（+ 三条约束）；`confirmation_bias` 不接及原因
- [x] §4.3「召回管道接线」：补 retention_bias 公式与力度、confirmation_bias 的边界
- [x] 归档 + 索引 + TODO + HANDOFF

## 下一步

B3 收编 `ProviderManager`（fallback，带开关）→ B4 人格联动 v2。
**B5/B6 等用户拍板**。

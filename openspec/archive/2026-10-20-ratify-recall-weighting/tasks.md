# Tasks: ratify-recall-weighting

- [x] 核对阻塞前提：`importance` 数据来源已于 2026-09-25 接线（`wire-importance-signal`）
- [x] 核对现设计依据：`mergeWithQuota` 注释里有实测（46 条 life_event 全被挤掉、路内第一）
- [x] 判定：旧加权形式是**全局绝对分**，与 9-25 的修复直接冲突 ⇒ **不实现**
- [x] `memory-system` §7 的分歧段改为**已决** + 判据
- [x] 补一条通用判据：**跨来源禁用全局加权求和，权重只在路内用**
- [x] 归档 + 索引 + `docs/TODO.md`（B1 销账，落成"等数据"而不是"待实现"）

## 证据（供后人复核）

- 现实现：`MemoryManager.applyKnobsToRetrieved`（乘性衰减 + `+0.15`）+ `mergeWithQuota`（相对阈值 + 配额外加）
- 观测：`[Recall] 候选 … → 过阈值 … → 选中 … | 重要度加分×N | Xms`（2026-09-25 上线）
- 反面证据链：`optimize-recall-pipeline` 的实测（同 spec `mergeWithQuota` 注释第 8-12 行）

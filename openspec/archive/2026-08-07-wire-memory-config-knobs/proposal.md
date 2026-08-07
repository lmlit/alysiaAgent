# Change Proposal: wire-memory-config-knobs

## 元信息

- **日期**: 2026-08-07
- **类型**: MODIFY（接线——补实现）
- **状态**: archived（代码已于 3b136d5 提交，本 change 为治理期补走完整流程的示范）
- **影响 spec**: ai-life-system（§11 亲密度引擎）

## 动机（为什么做）

代码审查（另一个 AI）发现：memory_config 旋钮（decay_rate / importance_threshold /
recency_weight / confirmation_bias）在系统里只有存/读/快照（PersonaStore /
getPersonaSnapshot / importRole），**从未参与任何决策**——life 系统亲密度衰减是
硬编码（`idleDays >= 3 → -2/day`）。等于"造了新逻辑，不接旧接缝"：两套衰减逻辑并存，
以后调旋钮不生效，排查懵。

按对账规则：memory-system spec §4.3 已声明旋钮驱动衰减 → 这是 **doc 已声明、impl 没接**
方向 → **改 impl，不改 doc**。

## 需求（做什么）

- [x] `updateIntimacy` 读取 `getPersonaSnapshot().memoryConfig`
- [x] `decay_rate`(0=不忘,1=秒忘) → 每日衰减幅度 = rate×6（默认 0.3→1.8/天）
- [x] `importance_threshold`(0=什么都记,1=只记大事) → 衰减阈值 = 2+(1−thr)×10 天（默认 0.4→8 天）
- [x] `recency_weight`(0=念旧,1=只认最近) → 近 3 天消息加权 (1+w)
- [x] `confirmation_bias`(0=随风倒,1=固执) → 亲密度变化平滑 ×(1−c×0.7)
- [x] `retention_bias` 明确不接（记忆正负偏向，不进亲密度；注释说明）
- [x] 加旋钮调试日志

## 设计决策

- **映射区间按代码真实语义**：审查建议假设 `decay_rate ∈ [-1,1]`，但 MemoryConfig
  类型注释是 `0=不忘,1=秒忘`（types.ts）——按 [0,1] 映射，默认值量级与硬编码一致（1.8 vs 2）
- **importance_threshold 语义反向**：阈值高=只记大事=忘得快→衰减阈值低；
  `2+(1−thr)×10`：只记大事→2 天，什么都记→12 天
- confirmation_bias 平滑防亲密度跳变（prev + (raw−prev)×(1−c×0.7)）

## 对账方向确认

- [x] 与 memory-system spec §4.3 无冲突（该 spec 声明旋钮存在，本 change 兑现"驱动衰减"意图）
- [x] 不涉及 Web API

## 测试计划

- 类型检查 `tsc --noEmit` 通过
- PersonaStore / memory-retrieval-time 13 个测试通过
- 运行时 `[Life] intimacy ... knobs:` 日志验证旋钮生效

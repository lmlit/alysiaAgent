# Tasks: optimize-recall-pipeline

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `LanceDBStore.search`：`.distanceType('cosine')` —— 显式改用余弦距离
- [x] `MemoryManager.mergeWithQuota`：保底配额 + 分数补位（替代全局 sort + slice）
- [x] 路内**相对阈值** `RELATIVE_KEEP = 0.7`
- [x] 文本去重（归一化后比较）
- [x] 合并顺序：`life_event` 排前面（去重先到先得，让语义更具体的标签胜出）

### ★ 实现中发现的两个额外问题

**1. 同一条生活事件在向量库存了两份**

`type='chat'` 的生活事件既被 `recordLifeEvent` 嵌成 `life_event`，
又被推送给你之后经 `RealtimeProcessor` 嵌成 `chat`。实测 **47 条 life_event 里 23 条
在 chat 里也有一份**。

**刻意不去掉写入端的重复**：那两份语义不同（"她的生活" vs "她对你说的话"），
`perspective` 视角过滤（`'self'` / `'interaction'`）正依赖这个区分。
改在**合并阶段按文本去重** —— 既避免同一句话占两个名额，又不动数据模型。

**2. 表上无向量索引**

`.distanceType('cosine')` 的前提是"索引距离度量与查询一致"。查了 `listIndices()` **0 个索引**
（暴力扫描），可自由选度量。已在代码注释里写明：**将来建索引必须也用 cosine**，否则结果无效。

## 实测对比（同一批 6 个话题，`scripts/recall-probe.ts`）

| | 修复前 | 修复后 |
|---|---|---|
| 生活事件召回 | **6 个话题 0 次** | 每个话题 **1-2 条** |
| 分数区间 | 几乎全 0.000 | **0.23 ~ 0.77** |
| 「你最近都在做什么呀」 | 0 条生活事件 | ✅ 「去给窗边的多肉浇水」 |
| 「你今天心情怎么样」 | 0 条 | ✅ 2 条（看月亮 / 凌晨看花） |
| 分数含义 | `1 − L2`（d=1 即归零） | **真实余弦相似度** |

## 测试

- [x] `tests/memory/recall-merge.test.ts`（11 用例）：
      四路保底、某路无候选让位、候选不足、`limit<=0`、
      **相对阈值不误杀低分来源**（长文本场景）、全 0 分不过滤、
      **重复文本只留一份且 life_event 标签胜出**、空白归一化、候选不够不硬凑
- [x] 回归：**685 passed**（+11）

## 明确不做（决策 4/5）

- **`importance_threshold` 继续空转** —— 四条写入路径没有一条写 `metadata.importance`，
  `+0.15` 分支从未执行。定义"什么算重要"是**产品语义决策**（生命周期？情绪强度？
  用户显式标记？），不是召回管道的优化。候选信号：生活事件的 `moodDelta`、消息的 `source`
- **`confirmation_bias` / `retention_bias` 不接** —— 需要"记忆的情绪极性"与"与既有信念的
  冲突度"，当前数据里都没有。硬接会变成和 `importance` 一样的空转旋钮

## Apply 任务

- [ ] `openspec/specs/memory-system/spec.md`：补召回管道契约（距离度量/合并策略/去重）
- [ ] 更新 `docs/HANDOFF.md`
- [ ] 回归 + 构建 + 重启服务

## 遗留

- **`score` 的绝对值含义**：换 cosine 后 score 就是余弦相似度，但**仍未加过滤阈值** ——
  无关话题依然会拿到 1 条生活事件（保底机制）。这是有意的取舍（见 proposal 决策 3），
  若观感不好再议
- 被 `RELATIVE_KEEP` 丢掉的候选没有日志，调参时看不到丢了多少 —— 需要时再补

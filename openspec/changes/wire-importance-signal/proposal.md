# Change Proposal: wire-importance-signal

## 元信息

- **日期**: 2026-09-25
- **类型**: NEW（补实现）
- **状态**: in_progress
- **影响 spec**: `memory-system`（§3.3 检索流程的 ⑤⑥ 两条）
- **前置**: `optimize-recall-pipeline`（管道已修好，就等数据）

## 动机（为什么做）

`importance` 是**设计过但从未接线**的：`events` 表有 `importance REAL DEFAULT 0.0` 列、
`EventStore` 读写它、`applyKnobsToRetrieved` 有 `importance > 阈值 → +0.15` 分支 ——
但**四条写入路径没有一条真正写入有效值**（唯一赋值是 `llm-agent.ts:284` 给她自己的回复
硬编码 `0.3`，且没进向量 metadata）。实测分布：`0.3`(481) / `0`(445)。

代码里留着明确的 TODO：
- `MemoryManager.ts:846`「importance 加分待 importance 计算接入后自动生效」
- `ProfileExtractor.ts:48`「服务端 ingest 不计算 importance（恒为 0），所以不过滤重要性」

**用户拍板的信号选择（2026-09-25）**：
- **生活事件 → 情绪强度**（贴合 soul.md「三千万世的人对什么记忆更深」的设定）
- **对话消息 → 摘要时顺带用 LLM 打分**（复用 `SessionEndProcessor` 已有的那次调用，几乎白捡）

## 需求（做什么）

- [ ] `memory/importance.ts`：`moodDeltaToIntensity()` + `lifeEventImportance()`
- [ ] `recordLifeEvent`：算 importance 写进**向量 metadata**（`ai_life_events` 无此列，
      而召回读的是 `r.metadata.importance`，所以放 metadata 即可，**不需要改表**）
- [ ] `RealtimeProcessor`：把 `event.importance` 一并写进向量 metadata（现在漏了）
- [ ] `SessionEndProcessor`：LLM 输出增 `important_moments: [{quote, importance}]`，
      按 quote 匹配回消息 → 回填 `events.importance` + **刷新向量 metadata**（重新嵌入后 upsert）
- [ ] `ProfileExtractor`：启用那个 TODO 里的重要度过滤（**带安全下限**，见决策 3）
- [ ] 单测 + 探针复跑

## 设计决策（怎么做，含备选与取舍）

**决策 1：importance 只进向量 metadata，不给 `ai_life_events` 加列**

召回读的是 `r.metadata?.importance`（`applyKnobsToRetrieved`）。生活事件表加列还要走
ALTER + 迁移，而 metadata 是现成通道。**不改表结构**。

**决策 2：`moodDelta` 用「基线 + 情绪加成」而不是纯情绪**

实测 `mood_delta` 格式很乱：`+1`(51) / `平静`(37) / `+0.01`(28) / `+0.1`(14) / `+2`(5) /
`+0.001`(5) / `warm`(2) —— **数字尺度差三个数量级，还混着情绪词**。

纯按数值当强度会把 `+0.01` 判成"几乎不重要"（可能只是另一个模型表达"略正向"的方式）。
所以取：
- **基线 0.3**（每条生活事件都有基本分量 —— 她确实过了这段日子）
- **情绪加成 0~0.4**（数字取 `min(0.4, |v| × 0.4)`；情绪词走小词表；未收录 0.2）
- **`origin='followup'`（对话余波）×0.8**（她自己的日常比她接你的话更值得记）

区间 0.24~0.7，而 `importance_threshold` 默认 **0.4** → 有情绪波动的过线、平静的不过线。
**有区分度**。

⚠️ 这套系数是**启发式**，不是从数据推出来的。全部提成具名常量便于调参。

**决策 3：`ProfileExtractor` 的过滤带安全下限**

原来是 `const significantEvents = events;`（全要）。改成按 importance 过滤后，
**若过滤后剩下的太少（< 3 条）则回退用全部** —— 避免重要度稀疏时把画像提取饿死。
宁可多提一点噪音，也不能让画像停止生长。

**决策 4：`important_moments` 用 quote 匹配回消息**

LLM 不可能返回事件 id。让它返回**原文摘句**，在会话时间窗内做包含匹配。
匹配不上的记日志（不静默丢），不阻塞主流程。

## 对账方向确认

- [x] **补实现**：spec §3.3 已声明 `importance > 阈值 → 加分`，实现里分支存在但数据恒 0 →
      按对账规则**改 impl 不改 doc**。本 change 正是补上被声明的那一半
- [x] `ProfileExtractor` 的过滤同样是"doc（注释）声明了意图、impl 没接"
- [x] 涉及 Web API？**不涉及**（importance 是 core 内部信号，Web 不直接读）

## 测试计划

- 单测：`moodDeltaToIntensity` 各形态（数字/词/空/null/异常值）、
  `lifeEventImportance` 的基线/加成/followup 折减、**阈值 0.4 处的区分度**
- 单测：`important_moments` 匹配（命中/不命中/空）、ProfileExtractor 安全下限回退
- 探针：复跑 `recall-probe.ts`，对比 `+0.15` 分支是否开始生效
- 回归：core 全量

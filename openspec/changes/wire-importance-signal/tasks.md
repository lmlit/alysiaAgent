# Tasks: wire-importance-signal

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `memory/importance.ts`：`moodDeltaToIntensity` + `lifeEventImportance`（系数提成具名常量）
- [x] `recordLifeEvent`：算 importance 写进**向量 metadata**（`ai_life_events` 不加列）
- [x] `RealtimeProcessor`：补上原先**漏传**的 `event.importance`（链路一直是断的）
- [x] `EventStore.updateImportance()`：只 UPDATE 该列，不重写整行
- [x] `SessionEndProcessor`：
      - 摘要 prompt 增 `important_moments[{quote, importance}]`（**复用同一次 LLM 调用**）
      - `parseImportantMoments` 逐项校验
      - `applyImportantMoments` 摘句子串匹配 → 回填 + **重新嵌入刷新向量 metadata**
- [x] `ProfileExtractor`：启用原 TODO 的过滤（带**安全下限**回退）

## 实测验证（2026-09-25）

记录 4 条测试事件读回向量 metadata（测完已清理）：

| 场景 | moodDelta | importance | 过 0.4 阈值 |
|---|---|---|---|
| 强情绪 | 雀跃 | **0.66** | ✅ |
| 低唤醒 | 平静 | 0.36 | ❌ |
| 无标记 | — | 0.30 | ❌ |
| 对话余波 | +1 | **0.56** | ✅（×0.8 折减后） |

**`+0.15` 分支终于会触发了** —— 接线前该分支从未执行。

## ★ 单测抓到一个真实缺陷

`parseImportantMoments` 原本**先截前 3 条再逐项校验**。若 LLM 返回 5 条其中 2 条非法，
后面的**合法项会被误伤丢掉**。改为**先校验、最后才截 3 条**。

## 测试

- [x] `tests/memory/importance.test.ts`（17 用例）：数字/词/空值、唤醒度不等于正负、
      子串匹配按强度降序、**相对默认阈值 0.4 有区分度**（不是全过也不是全不过）
- [x] `tests/memory/session-importance.test.ts`（11 用例）：解析校验、截断顺序、
      **摘句命中回填 + 向量 metadata 一起刷新**、空白差异、
      **匹配不上记日志不静默丢**、多条命中不同消息、
      **向量刷新失败不阻塞 importance 回填**、无 vectorStore 不崩
- [x] 回归：**713 passed**（+28）

## Apply 任务

- [x] `openspec/specs/memory-system/spec.md` §3.3 ⑤⑥：改写为实际接线方案
- [x] 更新 `docs/HANDOFF.md`
- [ ] 回归 + 构建 + 重启服务

## 遗留

- **系数是启发式**（`LIFE_BASE=0.3` / `LIFE_EMOTION_MAX=0.4` / `FOLLOWUP_FACTOR=0.8`），
  不是从数据推出来的。观察一段时间后按实际效果调 —— 探针可复跑
- **`mood_delta` 数据质量差**（数字尺度差三个数量级 + 情绪词混用），本实现不做尺度校准。
  若将来要让情绪强度更准，得先在**写入端**约束格式（改事件生成的 prompt）
- **`confirmation_bias` / `retention_bias` 仍未接线** —— 需要"记忆的情绪极性"与
  "与既有信念的冲突度"，当前数据没有。**importance 接线后，`retention_bias` 有了部分基础**
  （情绪强度可作为极性信号），但那是另一件事

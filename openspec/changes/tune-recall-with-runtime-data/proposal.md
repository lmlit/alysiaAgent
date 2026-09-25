# Change Proposal: tune-recall-with-runtime-data

## 元信息

- **日期**: 2026-09-25
- **类型**: MODIFY（观测 + 调参）
- **状态**: pending（**登记在案，等运行数据**——用户 2026-09-25「运行一段时间上服务器捞数据看看」）
- **影响 spec**: `memory-system`（§3.3 召回管道的系数）
- **前置**: `optimize-recall-pipeline` + `wire-importance-signal`（都已落地，管道是通的）

## 动机（为什么做）

`optimize-recall-pipeline` / `wire-importance-signal` 里的几个关键系数**都是启发式拍定的**，
不是从数据推出来的：

| 系数 | 值 | 依据 |
|---|---|---|
| `LIFE_BASE` | 0.3 | 拍的 |
| `LIFE_EMOTION_MAX` | 0.4 | 拍的（为了相对 0.4 阈值有区分度） |
| `FOLLOWUP_FACTOR` | 0.8 | 拍的 |
| `RELATIVE_KEEP` | 0.7 | 拍的 |
| `IMPORTANCE_FLOOR` / `MIN_SIGNIFICANT` | 0.4 / 3 | 拍的 |
| `moodDeltaToIntensity` 词表 | 各值 | 拍的字面直觉 |

**这些值该由运行数据定，不该由我一次定死。**

## ★ 前提问题：有些指标现在根本没记录

想靠数据调参，**得先有数据**。当前缺口：

| 想看的 | 现在有吗 |
|---|---|
| 生活事件 importance 的实际分布 | ✅ 有（向量 metadata / 可直接查库） |
| `+0.15` 分支的实际触发率 | ❌ **无日志** —— 分支是静默的 |
| 被 `RELATIVE_KEEP` 丢掉的候选 | ❌ **无日志** |
| 每轮实际召回了什么（source 分布/分数） | ❌ 只有 debug 级 |
| `important_moments` 的摘句匹配率 | ⚠️ 仅有失败时的 warn |
| `mood_delta` 的取值分布 | ✅ 有 |

## 需求（做什么）

- [x] **补观测日志**（先决条件，2026-09-25 已完成）—— 见下「已落地」
- [x] 回填历史数据（`scripts/backfill-life-importance.ts`）
- [ ] ~~写 `packages/server/scripts/recall-stats.ts`~~ —— **用户 2026-09-25 决定「要捞再说」**，
      暂不写。真到捞数据时再按当时的日志格式写（避免现在猜格式，过时了还得改）。
      那时要做的：扫 `alysia.db`（importance / mood_delta 分布、topics 覆盖率）+
      聚合 `data/logs/*.log` 的 `[Recall]` 行（选中分布 / 加分触发率 / 丢弃数 / 耗时）。
      先手搓也行：`grep '\[Recall\]' | awk` 就能出大部分数据。
- [ ] 部署到服务器，**跑一段时间**（建议 ≥1 周，覆盖工作日/周末/夜间）
- [ ] 捞数据 → 按实际分布调那些系数 → 再跑一轮对比
- [ ] 复跑 `recall-probe.ts` 做前后对比

## 已落地（2026-09-25）

**① 观测日志**（`[Recall]` 一行一召，**info 级**）

```
[Recall] 候选 life=2 chat=3 conv=5 → 过阈值 life=2 chat=3 conv=5
         → 选中 life=2 chat=2 conv=1 | 重要度加分×2 | 333ms
```

一行回答四个问题：各来源候选多少 / **被相对阈值丢了多少**（候选−过阈值）/
最终选中分布 / **重要度加分触发几次** / 召回耗时。

⚠️ **刻意用 info 而非 debug** —— 生产跑的就是 info，用 debug 等于没记（这正是要补日志的原因）。
量级：一天 50-200 行，可接受。

**② `scripts/backfill-life-importance.ts`**（幂等、支持 `--dry`）

接线前写入的 `life_event` 向量**没有 importance 字段**，不补历史数据的话
「加分触发率」这个指标要等很久才有有效样本。

实测回填 218 条：`0.70`(58) / `0.36`(50) / `0.30`(49) / `0.50`(22) / …，
**其中 80 条超过阈值 0.4**。回填后复跑探针，`重要度加分` 从恒 0 变为
`×0/×2/×1/×1/×1/×0` —— 指标活了。

**③ 顺带：`--dry` 立刻抓到我自己的一个 bug**

```ts
// 写错了：`a > b ?? c` 解析成 `(a > b) ?? c`，b 是 undefined 时恒 false
s.importance > config.memory?.importanceThreshold ?? 0.4   // → 统计静默输出 0
```
改成先取 `threshold` 再比较。**这就是 dry-run 的意义** —— 报了个"0 条超阈值"，
而分布里明明有 58 条 0.70。

## 探针已看出的初步信号（等更多数据再下结论）

1. **召回延迟 270-570ms/轮** —— 主要是 embed API 往返，**每轮对话都要付**
2. **`RELATIVE_KEEP=0.7` 过滤得不频繁**（多数时候 候选=过阈值）—— 可能该收紧
3. **保底配额稳定生效**：每个话题都能选到 1-2 条生活事件（修复前的目标是达成）

## 设计决策（怎么做，含备选与取舍）

**决策 1：观测用日志而不是新表**

加表要迁移，而且这些是**诊断数据不是业务数据**，不该长期占库。
日志捞完即可，符合项目既有的 `data/logs/` 模式。

**决策 2：脚本只读**

`recall-stats.ts` 绝不写库 —— 在**生产库**上跑，只读是硬约束。
（现有 `scripts/` 里已有多个一次性验证脚本，沿用这个模式。）

**决策 3：先积累再调，不边跑边调**

同时改观测和参数会让"变化是谁引起的"无法归因。先只加日志跑一轮拿基线，再动系数。

## 对账方向确认

- [x] 与现有 spec 冲突？无 —— `memory-system` §3.3 记录的是**当前实现**，
      本 change 会根据运行数据**更新那些系数的取值**（doc 跟随 impl 的实际调整）
- [x] 涉及 Web API？**不涉及**

## 待定的调参方向（有了数据再定，先列出假说）

1. **importance 若大量堆积在基线 0.3**（mood_delta 多为 `+0.001`/空）→ 基线该降，
   或情绪信号该换（写入端约束格式）
2. **`RELATIVE_KEEP=0.7` 若丢太多** → 放宽；若几乎不丢 → 收紧
3. **`+0.15` 若触发率极低** → 说明重要性没起作用，回去查写入端
4. **生活事件若总是占满保底位但从不被用** → 保底策略要重估（是否该给 conversation 更多位）
5. **`mood_delta` 尺度问题**（`+1` vs `+0.001` 差三个数量级）→ 可能要在**事件生成 prompt**
   里约束成固定格式，这才是根治

## 捞数据时的建议动作

```bash
# 服务器上（容器外）
sqlite3 ~/alysia/data/alysia.db "select importance, count(*) from events group by importance order by 2 desc limit 20;"
docker logs alysia-server --since 7d | grep -E "\[召回\]|important_moments|未匹配" | wc -l
```

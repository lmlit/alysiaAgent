# Change Proposal: resolve-fact-conflicts

## 元信息

- **日期**: 2026-10-28
- **类型**: FEATURE（记忆正确性）
- **状态**: in-progress
- **来源**: 用户提出「新旧事实冲突时，引导模型在下一轮主动提问，而不是静默覆盖」
- **关联**: `profile-facts-classification-confirm`（过期确认）、`profile-correction`（用户纠正优先）

## 问题

当前 `ProfileStore.addFact(s)` 遇到同 key / 子串包含的冲突时**直接裁决**：

- 旧事实立即 `superseded`，新事实 `active`；
- 旧的是 `source=user`、新的是 `inferred` 时，新事实**静默丢弃**；
- 没有候选队列，也没有“下一轮问用户”的入口。

已有的 `[待确认的事实]` / `confirm_profile_fact` 只处理**过期 ≤3 天**的事实，
不处理**新旧冲突**；且冲突往往是“同一个属性不同值”（长沙 vs 杭州），
归一化 key 根本不相交，现有实现甚至不会发现。

## 目标（完整闭环，不是 demo）

1. **语义冲突检测**：在同一次画像提取调用里，让 LLM 对照已有活跃事实，
   对每条新事实输出 `conflicts_with`（已有事实原文或 null）；不额外加一次 LLM 调用。
2. **候选队列**：模糊/推断冲突进 `fact_conflicts` 表，旧事实保持 active，
   新事实**先不激活**，也不进 facts 块。
3. **下一轮自然提问**：`pendingConflict` 必选块注入旧/新对照 + `conflict_id`；
   模型在合适时机问一次；有冷却、最多问 2 次、14 天过期，防止盘问。
4. **用户裁决**：`resolve_profile_conflict(conflict_id, keep: old|new)` 工具：
   - `new` → 旧 superseded，新 active + `confirmed_at`，basics 标 stale；
   - `old` → 新候选丢弃，旧事实按分类续期；
   - 两者都写审计行，不删除历史。
5. **硬契约不变**：`source=user` 的明确陈述/纠正**立即生效**，不排队、不被提问拖住。
6. **可观测**：创建/去重/提问/裁决/过期都有日志；`pending` 队列可查询。
7. **兼容**：老库无表自动建；老 facts 无 `confirmed_at` 正常渲染；旧测试按新语义更新。

## 数据模型

`fact_conflicts`（SQLite，新表）：

```
id, session_id,
old_fact_key, old_fact, old_source, old_confidence,
new_fact_key, new_fact, new_source, new_confidence, new_category,
evidence, source_event, channel,
status: pending | kept_old | kept_new | expired,
occurrences, created_at, last_seen_at, asked_at, ask_count,
resolved_at, resolution
```

- `UNIQUE(old_fact_key, new_fact_key) WHERE status='pending'`：同一对冲突只留一行，重复出现只累加 `occurrences`。
- 上限 20 条 pending；超了把最旧的标 `expired`（不静默丢，日志可见）。
- 14 天未裁决 → `expired`；问满 2 次后再等 3 天 → `expired`。

## 明确不做

- 不改 `character_facts`（她对自己的叙述；冲突语义不同，另开）。
- 不自动重写 `basics`（只标 stale，由既有 Cron 重写）。
- 不做控制台页面（先保证核心链路 + 工具 + 测试；API 方法可后接）。

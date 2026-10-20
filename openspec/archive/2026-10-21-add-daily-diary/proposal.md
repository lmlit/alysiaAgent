# Change Proposal: add-daily-diary

## 元信息

- **日期**: 2026-10-21
- **类型**: FEATURE（B 类：新增行为，默认启用）
- **状态**: `draft`
- **影响 spec**: `ai-life-system`（新增 §12 日记）、`memory-system`（新表）
- **配套前端**: `blog/` 新增「日记」独立栏目（半公开：不在首页混排）

## 要什么

她每天写一篇日记，**第一人称、300–600 字**，写"刚过去的一天"。
存在库里，同时同步到她自己的博客的**独立「日记」栏目**（不混进首页随笔列表）。

与现有两类东西的区别：

| | 随笔（已） | 每日反思（已） | **日记（新增）** |
|---|---|---|---|
| 谁看得见 | 公开 | 只有她自己（`reflection` 字段） | 半公开（独立栏目，首页不混排） |
| 频次 | 不定期，她想写才写 | 每天一记，**给系统看** | **每天一篇**，给人看 |
| 语气 | 打磨过的散文 | 复盘/自省，偏分析 | 松散的、当天的、允许琐碎 |
| 用途 | 表达 | 驱动人格微调 | 留痕 + 让人看到她每天的样子 |

## 数据

新表 `ai_life_diaries`：

```sql
CREATE TABLE IF NOT EXISTS ai_life_diaries (
  date        TEXT PRIMARY KEY,   -- YYYY-MM-DD（写的是"过去的这一天"）
  content     TEXT NOT NULL,      -- 日记正文
  mood        TEXT,               -- 当天 mood 词（用于博客封面选图）
  mood_value  REAL,               -- 数值（-1..1 或 0..1，跟 LifeState 一致）
  created_at  TEXT NOT NULL
);
```

## 生成

挂在 `LifeService.tick()` 的跨天段，紧跟 `maybeDailyReflection`：

```
maybeDailyDiary(now):
  today = localDateKey(now)
  if state.diaryDate === today: return        // 跨天只写一次
  材料 = 过去 24h 事件 + mood + 近 3 天摘要 + **上一篇日记的最后一句**
  日记 = LLM(materials)                        // 注入式回调，失败不置位、次日重试
  saveDiary(date=昨天, ...)
  state.diaryDate = today
```

**为什么要"上一篇的最后一句"**：日记的价值在连续性。没有它，每天都是孤立的 300 字；
有了它，能写出"昨天说的那件事，今天有下文了"这种只有连续写才有的东西。

## 博客侧（半公开）

| 项 | 做法 |
|---|---|
| 栏目 | `blog/src/pages/diary/index.astro`（按日期倒序列出）+ `diary/[...date].astro`（单篇） |
| 首页 | **不出现**。随笔列表只查 `category !== '日记'` |
| 归档页 | 日记**进**归档（那里就是时间线，正是它该待的地方） |
| 封面 | 按 `mood` 从素材库选图（沿用 `make-covers.py` 的映射） |
| 同步 | `deploy.ps1` 构建前 `ssh` 拉 `diary export --since` 的 JSON → 生成 md |

## 不做

- 不做"日记可编辑"（她写完就是写完，改历史等于篡改记忆）
- 不做评论/点赞
- 不做日记的 RSS 独立订阅（先跟全站 RSS 一起）

## 回滚

- 库里：`ai_life_diaries` 留空即可，不影响任何链路
- 博客：删 `diary/` 栏目 + 同步步骤；已生成的 md 去掉

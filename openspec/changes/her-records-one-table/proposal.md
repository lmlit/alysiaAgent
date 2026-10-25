# Change Proposal: her-records-one-table

## 元信息

- **日期**: 2026-10-25
- **类型**: MODIFY（合并存储 + 补上「她读自己的日记」）
- **状态**: applied
- **影响 spec**: `ai-life-system`（日记/反思/私密本的存储与回读契约）

## 动机：我上一轮错在"把同一类的投影当成六种物种"

用户问「两本日记为什么不做」，我列了六样（反思正文 / insight / mood_note / intent / 公开日记 / 摘要），
然后说"都有落点了"。用户回了一句关键的话：**「你列出来的那些其实是同一类吧，可以收到一起不」**，
以及 **「A 的作用是啥，她写的日记不读的话还叫日记吗」**。

两句都对：

1. **它们是同一类** —— 都是"她自己的产物"，只是**读者**、**形态**、**生命周期**不同。
2. **不读的日记不是日记** —— 我提的 A 方案（只写不读）等于造一个日志文件。

核对后发现的真实情况（生产实测）：

| 候选 | 谁读它 | 结论 |
|---|---|---|
| `ai_life_state.reflection`（每日反思正文） | **没有任何人**：无 API、无页面、不进 prompt | **只写不读** —— 跑了 11 天全白写 |
| `character_facts`（insight） | 注入【关于我】 | 有观众（她读得到） |
| `mood_note` | 注入【心情】 | 有观众 |
| `intent` | 到期推给用户 | 有观众 |
| `ai_life_diaries` | 半公开（进博客） | 有观众 |
| `daily_summaries` | 只进 prompt | 系统用，不是她的 |

## 需求

**合并**（同一类：某一天、一段她自己写的第一人称叙述）：

| 收进来的 | kind | visibility | 变化 |
|---|---|---|---|
| 公开日记 | `diary` | `shared` | 搬家，行为不变（博客照读） |
| **私密日记（新）** | `diary` | `private` | **不加滤镜**，只有她和你 |
| 反思正文 | `reflection` | `private` | 从"每天覆盖、无人读" → **逐日累积、可回读** |

**不合并**（语义不同，硬塞会把四种东西压成一种）：
`facts` / `character_facts`（可查询断言，要 TTL）、`mood_note`（当前状态）、`intent`（待办）。

## 关键设计：**回读**才是日记

| 谁读 | 读什么 |
|---|---|
| 她（生活事件生成） | 最近 2 篇私密日记，每篇截 80 字 |
| 她（次日反思） | 最近私密日记（同一 `buildPrivateDiaryBlock`） |
| 你（Web 只读，后续） | 全文 |
| ❌ 聊天 prompt / 推送 / 博客 | 绝不 —— 否则她又开始为观众写 |

## 为什么新表而不是给老表加列

`ai_life_diaries.date` 是**主键**，一天只能一篇；加第二本要改主键（SQLite 需重建表，风险高）。
新表另有 `UNIQUE(kind, visibility, date)`，语义正好是"一天一篇/每本"。

## 迁移（幂等）

启动时 `INSERT OR IGNORE`：
- `ai_life_diaries` → `kind='diary', visibility='shared'`
- `ai_life_state.reflection` → `kind='reflection', visibility='private'`
旧表**冻结不删**；读路径（`getDiary`/`listDiaries`/`getLastDiaryTail`）先查新表、空则回落旧表。

## 测试

- `her-records.test.ts`（9 例）：一天一篇覆盖 / 公开与私密并存 / 私密不进公开查询 /
  反思逐日累积 / `lastRecordTail` / 兼容层三方法 / 旧表回落
- `life-service.test.ts` +3 例：写了才存在（**无素材时不写**——硬写就是编）/ 没注入生成器不写 /
  ★ **回读**：私密日记真的进了生活事件生成的 context
- 全量 **169 文件 / 1974 用例**

## 本地真机验证（按规矩：先本地，再生产）

在本地库注入"旧日记 1 篇 + 旧反思 1 条" → 起本地真服务 → 复查：

```
ai_life_records:
  diary      shared   2026-10-20  老的公开日记。…
  reflection private  2026-10-19  旧的反省：今天话说多了…
records = 2 · legacy diaries = 1（冻结未删）
```

再启一次 → 仍 2 条（**幂等**）。对话同时正常（她照常回话）。

## 风险

- ⚠️ 私密日记多一次 LLM 调用/天（≤2048 tokens 上限，实际约 300）。
- ⚠️ 若将来有人把 `visibility='private'` 的记录注入聊天，它就变成表演 ——
  契约写进 spec，并在 smoke 里守住"聊天组装不含私密内容"。

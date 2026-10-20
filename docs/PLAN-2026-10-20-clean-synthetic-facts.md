# 方案：清理合成注入残留（KI-20 存量）—— **未执行；且查证后：多半已经不用做**

- **日期**: 2026-10-20
- **change**: `plan-synthetic-data-cleanup`（B6，**只出方案，不动数据**）
- **用户决定**: 「先只出方案 + 备份脚本，不动数据」
- **状态**: ⏳ 方案就绪

---

## ★ 0. 先更正一个前提（2026-10-20 查证）

我在盘接缝时把「116 条存量未清」当成了待办。翻 `docs/KNOWN-ISSUES.md` 的 KI-20 发现：
**它已于 2026-10-17 被 `purge-synthetic-context-pollution` 清除**
（180 条注入事件 + 1 条派生 fact；远端为基准重建，召回抽查通过）。

所以本文件的定位变了：

| 用途 | 说明 |
|---|---|
| **复验**（主要） | 用 `scripts/synthetic-data-audit.cjs` 确认"清理仍然成立"。判据 `facts.fromSynthetic == 0` |
| **预案**（备用） | 若某天 `fromSynthetic > 0`（新环境/新采集路径），按下面的步骤清 |

⚠️ **`events.synthetic` 非 0 是正确的** —— 事件按定义不可变，10-17 那次清的是**派生 fact**。

---

## 1. 要清什么、为什么

`KI-20`（已修）：dsh 每一步之前会把「动态运行时上下文」投影成一条 `user/message`
塞进会话，adapter 照单全收 ⇒ 那段文本以 `role:'user'` 入库，造成两条自指回路
（画像从画像里重新学出画像；人格从注入文本再触发 hints）。

**新数据已堵住**（`filter-synthetic-context-inflow`：写入侧打 `skip_profile` + `synthetic`，
服务端两处判定都认）。**存量**：2026-10-17 已清（见 §0）；下面是**再次出现时**的处理口径。

| 对象 | 处理 | 理由 |
|---|---|---|
| `events` 里的 synthetic 行 | **不删** | Event Log 按定义**不可变**（KI-12 已立的契约）；删了会破坏审计链与摘要窗口锚点 |
| `user_profile.facts` / `character_facts` 中 `source_event` 指向 synthetic 事件的条目 | **作废**（`status='superseded'` + `valid_until=now`） | 与 `memory-correction` 同款：**保留审计链**，不物理删 |
| 含 synthetic 的会话**摘要** | **人工判断** | 不能自动认定整篇摘要被污染——会话里通常也有真实发言 |

> ⚠️ **为什么 facts 不物理删**：作废后它们不再进 prompt、不再参与召回，
> 但"曾经记过什么"仍然可查。物理删是不可逆的，而这次是**可能判错**的清理。

---

## 2. 执行前：先看数字（只读）

```bash
# 本机没有线上库时，先 scp/挂载一份，或直接在服务器上跑（脚本只读）
E:/nodejs24/node.exe scripts/synthetic-data-audit.cjs --db <alysia.db>
```

输出会给出：事件总数 / synthetic 条数与分类 / facts 总数与其中多少条来自 synthetic /
涉及的会话数（前 5 个列出）。

**判断点**：`facts.fromSynthetic` 为 0 ⇒ 这次清理几乎无收益，可以不做；
只有 `facts` 相关的东西会影响她读到的画像。

## 3. 执行前：备份（必须先做）

```bash
E:/nodejs24/node.exe scripts/synthetic-data-audit.cjs --db <alysia.db> --backup <备份目录>
```

脚本只做**文件级复制**（`db` / `-wal` / `-shm`），不执行任何 SQL 写。
⚠️ WAL 模式下**必须连同 `-wal` 一起备**，否则备份出来的库可能缺最新提交。

## 4. 清理（人工复核后执行，**不在脚本里**）

先导出待作废清单并人工过一遍（`--json` 的 `sampleFacts` 只给前 10 条，全量用 SQL）：

```sql
-- ① synthetic 事件 id 集合
WITH synth AS (
  SELECT id FROM events
  WHERE COALESCE(json_extract(payload,'$.synthetic'),'') <> ''
     OR COALESCE(json_extract(payload,'$.skip_profile'),0) <> 0
)
-- ② 由它们产出的用户事实（人工看 fact 文本，确认确实是注入文本学出来的）
SELECT json_extract(value,'$.fact')            AS fact,
       json_extract(value,'$.source_event')    AS source_event,
       json_extract(value,'$.source')          AS source,
       json_extract(value,'$.confidence')      AS confidence
FROM user_profile, json_each(user_profile.facts)
WHERE json_extract(value,'$.source_event') IN (SELECT id FROM synth);
```

人工确认后才写库 —— **建议走已有的纠正接口**而不是直接 UPDATE：
`MemoryManager.confirmProfileFact(fact, false)` / `ProfileStore.confirmFact` 早已实现
「先作废旧、再写入新」的语义（`add-memory-correction` 里就是用它），
直接 UPDATE 容易漏掉 `valid_until` 或漏掉角色画像那一侧。

## 5. 不进本方案的

- **不删 events**（不可变）
- **不重跑摘要**：重摘要要动 `summary_status` 与窗口锚点，风险远大于收益；
  若确认某篇摘要污染严重，走人工改写（`conversations.summary`），并在记录里写明原因
- **不碰 dsh 侧**：adapter 那边是过滤逻辑，不是数据

## 6. 回滚

1. 备份在哪：第 3 步的目录（文件级）
2. 作废可逆：把 `status` 改回 `active`、清 `valid_until`（记得同时对照 `facts` 与 `character_facts`）
3. **先小批量试**：只处理 `confidence < 0.5` 的那批，观察 3 天召回与画像质量再决定剩余

## 7. 完成判据

- `scripts/synthetic-data-audit.cjs` 的 `facts.fromSynthetic` == 0
- `events.synthetic` **保持非 0**（这是对的：事件不删）
- 画像页 `[关于我]` / `[关于你的事实]` 里不再出现注入文本学出来的条目

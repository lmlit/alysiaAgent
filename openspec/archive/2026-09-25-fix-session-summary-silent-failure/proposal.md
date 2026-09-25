# Change Proposal: fix-session-summary-silent-failure

## 元信息

- **日期**: 2026-09-25
- **类型**: FIX
- **状态**: archived（2026-09-25 实现+实测完成）
- **影响 spec**: `memory-system`（§2.4 Conversation Store 表结构 / §7 错误处理 & 边缘情况）
- **发现来源**: 2026-09-25 线上日志 + 权威库排查（服务器 `~/alysia/data/alysia.db`）

## 动机（为什么做）

**线上会话摘要已静默失败 22 天，100% 失败率，每 6h 的增量摘要归档存的全是占位符。**

### 证据链（三路交叉）

| 来源 | 事实 |
|---|---|
| 数据库 | 134 条 conversation，**最后一次真摘要是 2026-09-03**；9-04 起 22 天 0 成功 |
| 日志 | `[Memory] onSessionEnd` 4 次 / `[SessionEnd] summary LLM failed` 4 次 = **4/4** |
| 时间线 | 镜像 9-01 23:43 构建、容器 ~9-04 重启、**最后成功 9-03** —— 严丝合缝 |

分日断崖：

```
8-11 ~ 9-02   真摘要/占位符 混合，约 55% 成功
9-03          1 成功  ← 最后一次
9-04 ~ 9-24   全部占位符，0 成功
```

### 为什么"静默"

日志**确实记了** `logger.warn(...)`，但从没变成信号，六层叠加：

1. **级别错配**：用 `warn`，而全局比例 19,556 INFO : 16 WARN : 11 ERROR
2. **被噪声埋掉**：**96.6% 的日志行是 `QQ Official`**（18,958/19,634）
3. **降级是设计好的兜底**：`catch → return defaultSummary`，系统捕获、记一行、继续跑
4. **没有机制在读日志**：写文件 → 7 天轮转删除，无告警无聚合
5. **占位符长得像内容**：`"Session xxx summary"` 是非空字符串，在库里与真摘要并排
6. **测试抓不到**：单测 LLM 是 mock 的，永远返回合法 JSON

> 存活检查全程是绿的：容器 `"Status":"healthy"`、`/api/health` → `{"status":"ok"}`。
> **坏的不是"活着"，是"做对"。** 这条经验应写进 spec（见设计决策 4）。

### 根因（★ 已用真实 API 验证，见下"实测"）

**主因：`max_tokens: 512` 对「推理模型」太小 —— reasoning 与可见内容共用同一份预算。**

实测探针（`scripts/verify-session-summary-fix.ts` 同类请求的原始响应）：

```
max_tokens=512 : completion_tokens=312，其中 reasoning_tokens=242，reasoning_content 801 字
max_tokens=2048: completion_tokens=321，其中 reasoning_tokens=258
```

`CHAT_MODEL`（deepseek-v4-flash）是**推理模型**：每次调用先花 ~250 tokens 在 reasoning 上，
**再**开始输出可见内容，两者共用同一个 `max_tokens`。512 的预算下，对话稍长
→ reasoning 膨胀 → **留给可见内容的额度变成 0** → 返回 `HTTP 200` + `content 为空`。

**这同一个 512 是两处故障的共同根因**（原以为是两个独立问题，实测证明是一个）：

| 槽位 | 引用位置 | 线上症状 |
|---|---|---|
| `session.summary` | MemoryManager slotify → SessionEndProcessor | 会话摘要 **22 天 100% 失败** |
| `life.generateSummary` | `bootstrap.ts:200`（每日反思引用它） | 每日反思 **7 天 11 次 empty response** |

**触发点**：`b9c845d`（8-28，memory-character-perspective）给摘要 prompt 加了
`character_perspective` 字段 → reasoning 变长 → 越过 512 的临界点。
**加一个字段，成功率 55% → 0%。**

### 次因（让它变成"静默"故障）

1. **`SessionEndProcessor.ts:163` 裸解析**：`JSON.parse(response)` —— 无围栏剥离、无截断修补、无重试。
   对比 `life.ts:962` **做了**围栏剥离——同一项目一处做了一处漏了。
   注意：围栏**不是主因**（实测主因是预算），但它是把"输出异常"放大成"必然解析失败"的放大器。
2. **这条链路没设 `response_format: json`** —— 对比 `bootstrap.ts:142` 生活事件那条设了。
3. **失败被伪装**：`catch → return defaultSummary` 存了个像内容的占位符字符串
   （这才是"22 天无人发现"的直接原因）。

### 实测（真实 DeepSeek，`scripts/verify-session-summary-fix.ts`）

```
修复前：3/3 失败（0 字 → Unexpected end of JSON input；483/285 字 → Unterminated string）
        报错形态与线上日志逐字一致
修复后：首次调用失败 1/3（模型抖动）→ 重试后 0/3 失败
```

⚠️ **单测结构性地抓不到这个 bug**：单测里 LLM 是 mock 的，永远返回合法 JSON。
必须用真实 API 验证——这也是它能在线上活 22 天的原因之一。

### ⚠️ 当前 master 比线上更糟

`ab86ed3`（9-25 wire-importance-signal）又往同一 prompt 加了 `important_moments`
（1-3 条逐字摘句），输出更长、512 更不够。**不修就部署 = 把已知会 100% 失败的代码推上去。**

### 连带的二次伤害（需本 change 一并确认）

`ConversationStore.ts:17` 向量是**拿 summary 文本 embed 的**：
```ts
await this.vectorStore.insert(conv.id, vector, conv.summary, {...})
```
⇒ 52 条占位符**生成了 52 条近乎相同的垃圾向量**躺在 LanceDB 里，可能被召回出来，
**污染正在调参的召回管道**。（存量清理见 change `backfill-failed-session-summaries`）

## 需求（做什么）

### A. 加固：让失败变少

- [ ] 抽取共用的「LLM JSON 输出解析」工具（剥 markdown 围栏 + 裸文本兜底 + 截断检测），
      `life.ts` 与 `SessionEndProcessor` **共用同一实现**——消除"一处做了一处漏了"的结构性隐患
- [ ] `session.summary` 槽 `max_tokens` 512 → 2048（`sampling.ts`）
- [ ] 该链路补 `response_format: json`

### B. 可见：让失败不再伪装成成功（用户 2026-09-25 明确认可的方向）

- [ ] `generateSummary` 失败时**不再返回 `defaultSummary`**，改为向上抛出/返回失败标记
- [ ] `process()` 收到失败时：**仍然插入 conversation 行**（保留 message_count / 时间 / 事件关联），但
      - `summary = ''`（空，**绝不写占位符**）
      - `summary_status = 'failed'`
      - **不生成 embedding**（不污染向量库）
- [ ] 迁移：`ALTER TABLE conversations ADD COLUMN summary_status TEXT DEFAULT 'ok'`
      （遵循项目规范：**ALTER TABLE + try-catch，不 DROP**）
- [ ] 检索侧过滤：`getRecent` / `searchByText` 排除 `summary_status='failed'`，防空摘要进 prompt

### C. 补处理

- [ ] 失败的会话沿用 §7 既有模式「失败跳过，下次 cron 补处理」——cron 扫描
      `summary_status='failed'` 的行重新摘要（本 change 只做**机制**，存量数据见下一个 change）

## 设计决策（怎么做，含备选与取舍）

**决策 1：加 `summary_status` 列，而不是让 `summary` 可空**

`summary TEXT NOT NULL`。备选：(a) ALTER 成可空 → 破坏既有查询假设、NULL 语义含糊；
(b) 不插行 → 丢 message_count/时间/事件关联，且事件已被标记 PROCESSED_SUMMARY，**数据永久丢**；
(c) **加状态列**（选中）→ 缺失**可查询**（`WHERE summary_status='failed'`）、可回填、
不丢关联、迁移最小。

**决策 2：失败时不生成 embedding**

垃圾向量的害处比"缺一条向量"大得多——缺了只是召回少一条，垃圾会被**召回出来当真内容用**，
还会干扰相似度分布（正在调的 `RELATIVE_KEEP` 等系数会被污染样本带偏）。

**决策 3：抽取共用解析工具，而不是在 SessionEndProcessor 里再抄一份**

本质问题是**同一个需求在两处实现、只做对了一处**。再抄一份只是把这个问题复制一遍。
抽成共用工具后，`life.ts` 的行为不变（回归测试保），SessionEndProcessor 获得同等健壮性。

**决策 4：把"存活 ≠ 正确"写进 spec**

本次故障 22 天里所有存活检查都是绿的。spec §7 应显式区分两类失败，避免下次再被
"容器 healthy"误导。（监控/日报本体**不在本 change**，另见 `add-ops-health-report`）

## 对账方向确认

- [x] 与现有 spec 冲突？**无**。§2.4 记录的是当前表结构（本 change 增列）；
      §7 表格新增一行"LLM 返回非法 JSON"的处理策略（当前表里没有这一行，属**补实现/补文档**）
- [x] §7 已声明「LLM 提取失败 → 失败跳过，下次 cron 补处理」——本 change 的 C 部分**正是把这条
      落到会话摘要上**（当前实现违背了它：不是"跳过"，是"存占位符"）。属 **doc 对、impl 没接 → 改 impl**
- [x] 涉及 Web API？`summary_status` 是内部字段，**不新增/不修改 `/api/*` 契约**；
      但 `getRecent` 过滤会影响 Web 端会话列表内容，需确认 console 无需改动

## 测试计划

- [ ] **回归**：`life.ts` 剥离围栏行为不变（既有测试必须全过）
- [ ] 单测：带 ```json 围栏的响应 → 正确解析（**当前必失败，即本 change 的靶子**）
- [ ] 单测：被截断的 JSON → 判定为失败，**不写占位符**、不生成 embedding
- [ ] 单测：空白响应 → 同上
- [ ] 单测：解析持续失败 → conversation 行 `summary_status='failed'`，`summary=''`
- [ ] 单测：`getRecent` / `searchByText` 不返回 `summary_status='failed'` 的行
- [ ] 迁移测试：旧库（无该列）启动 → ALTER 成功、存量行 `summary_status` 为 `'ok'`
- [ ] **反例测试（关键）**：断言库中**永不出现** `summary LIKE 'Session %summary'`
      ——把本次事故固化成测试，防止回归
- [ ] 用真实 DeepSeek 跑一次真实会话摘要（E2E），确认成功率

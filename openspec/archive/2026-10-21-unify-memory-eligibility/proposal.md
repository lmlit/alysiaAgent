# Change Proposal: unify-memory-eligibility

## 元信息

- **日期**: 2026-10-21
- **类型**: DESIGN + FIX（把已有的局部判据收成单一来源，并补上失效/重建/分账）
- **状态**: **archived**（2026-10-21 归档；spec 合并为 `memory-system` §10，代码在 `feat/unify-memory-eligibility`）
- **影响 spec**: `memory-system`（§2 数据模型 / §3 调度流程 / §4 画像引擎 / §5 Prompt 注入 / §7 错误处理）
- **前置**: 无。不依赖任何"等数据"的 change（KI-1/2/11 不碰）
- **不涉及**: 架构替换、第二套向量库、存量数据迁移

## 1. 缘起：不是缺算法，是缺判据

本文档来自一次代码审查。结论与用户判断一致：**主架构保留，规则收敛**。

现状并不缺能力——原始事件、会话摘要、结构化事实、角色状态、长期检索都各就各位；
缺的是**"这条内容能不能用于这个用途"的判据只有一个出处**。今天这个判据被**至少抄了四份**：

| 出处 | 判据写法 |
|---|---|
| `EventStore.getLastUserMessageAt` (SQL) | `role='user'` + `skip_profile=0` + `synthetic=0` |
| `RealtimeProcessor.process` | `skip_profile !== true`（**不看 role**） |
| `ProfileExtractor.extract` | `role==='user' \|\| sender_id` + `skip_profile !== true`（**不看 synthetic**） |
| `SessionEndProcessor.processInner` | `!payload.synthetic`（**不看 role**） |

四份写法互不相同，于是"哪条内容能学、能学成什么"取决于**你恰好走的是哪条路径**。
下面 7 条是这四份判据互相矛盾的**直接后果**（全部经代码核实，行号为 2026-10-21 的 `main`）。

## 2. 已核实的事实（每条都能红→绿）

| # | 现象 | 证据 | 归属约定 |
|---|---|---|---|
| **E1** | 合成注入在**补处理**路径重新进摘要：正常摘要过滤 `synthetic`，`retryFailedSummary` 不过滤 —— 同一窗口"第一次摘滤掉、第二次摘收进去" | `SessionEndProcessor.ts:155-156`（过滤） vs `:383-390`（不过滤） | C1 |
| **E2** | **过期事实经 `basics` 复活**：`deepProfile` 读的是 `user_profile.facts` 的**原始 JSON**（等价 `getAllFacts()`，含 `superseded`/`expired`），而 `basics` 会作为 `[关于你]` 注入 prompt | `CronProcessor.ts:125-126`；注入点 `PromptAssembler.ts:188-192` | C2 |
| **E3** | 纠正候选池含已失效事实：纠正提示词把 `getAllFacts()` 全量喂给 LLM，可能去"纠正"一条早已 `superseded` 的旧说法 | `RealtimeProcessor.ts:93`、`MemoryManager.ts:327` | C2 |
| **E4** | **她自己的话被当成用户反馈**：`process()` 对任何非 `skip_profile` 事件跑人格扫描与纠正快路径，**完全不看 `role`** ⇒ 她说一句带"不要"的话就会调整她自己的人格；而 ingest 侧明确知道 role 存在且"判错会把画像写反" | `RealtimeProcessor.ts:82-112`；对照 `server/src/ingest.ts:114-117` | C1 |
| **E5** | **事实提取失败被静默消耗**：`extract()` 失败只留一行 error、返回空数组；`processInner` 照旧 `markProcessed`；摘要行 `status='ok'` ⇒ 锚点前进 ⇒ 该窗口事实**永久不可重提** | `ProfileExtractor.ts:137-149` → `SessionEndProcessor.ts:282-298` → `MemoryManager.ts:1328-1332` | C4 |
| **E6** | **"结算成功"是 `void`**：`onSessionEnd` 返回 `void`，摘要失败也不抛 ⇒ 调用方打印"记忆已归档" | `MemoryManager.ts:1335-1347`；`server/src/chat.ts:95-101` | C4 |
| **E7** | **派生结果没有谱系**：`basics` 不记录自己由哪些 fact 生成 ⇒ 事实被纠正后无从判断 `basics` 是否过时，也无法只重建它 | `user_profile` 只有 `basics/updated_at`（`database.ts:53`） | C3 |

⚠️ 与已归档 change 的关系（**不重复修**）：
KI-20（`filter-synthetic-context-inflow`）修的是"合成注入进不进学习"的**三条路径各打一个补丁**；
KI-14/15/17 修的是"摘要/向量分别记账"。本 change 不动它们的结论，只把**判据出处收成一个**，
并补上它们没覆盖的三件事：**失效传播**（E2/E3）、**派生重建**（E7）、**阶段分账**（E5/E6）。

## 3. 四条设计约定

### C1 统一来源与用途（一张表，一个函数）

新建 `packages/core/src/memory/eligibility.ts`，导出**唯一**判据：

```ts
type MemoryUse = 'profile-facts' | 'persona-evidence' | 'correction' | 'summary' | 'embed' | 'worldbook';
type EventOrigin = 'user' | 'assistant' | 'self-life' | 'agent-delegated' | 'synthetic' | 'npc';

isEligible(event, use): { ok: boolean; reason?: string }   // 判定 + 跳过原因（reason 直接进日志）
```

矩阵（**新增用途必须先登记这里**；实现在 `packages/core/src/memory/eligibility.ts` 的 `ELIGIBILITY`，
`eligibility.test.ts` 会断言"每一格都有明确答案"，缺格即红）：

| 来源 \ 用途 | profile-facts | persona-evidence | correction | summary | embed | worldbook |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `user` | ✅（直接陈述） | ✅ | ✅ | ✅ | ✅ | ✅ |
| `assistant` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `self-life`（她自己生活） | ❌ | ❌（mood 漂移走 `adjustFromMood`，不读文本） | ❌ | ❌ | ✅ | ✅ |
| `engine`（执行回执 `role:engine`） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `agent-delegated`（委托会话） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `synthetic`（合成注入） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `npc`（群聊非 owner） | ❌ | ❌ | ❌ | ✅（既有行为） | ❌ | ✅ |
| `tool`（tool_call/result） | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `unknown`（判不出来） | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

⚠️ 实现时改正了提案初稿里的两处：`agent-delegated` 的 `embed` 改 **❌**（今天它也带 `skip_profile`，
本来就早退不嵌入；写成 ✅ 会**顺手引入**当年 `purge-subagent-pollution` 清掉的那种污染），
并补上初稿漏掉的三行（`engine` / `tool` / `unknown`）。

**assistant 保留 summary 与 embed**：她说过的话是**对话历史**的一部分（要能回忆"我们聊过什么"），
但不是**关于用户的证据**。这正是"历史记录"与"当前认知"的区别在来源维度的投影。

**unknown 保留 embed**：老数据判不出来源时仍可被检索（与现状一致），但它**不参与学习**——
宁可召回一条来源不明的话，也不静默让它消失。

### C2 统一有效性（两档读取，不许混用）

| 档 | 内容 | 允许 | 不许 |
|---|---|---|---|
| **historical** | 事件、会话摘要、向量、审计 | 原样读取、当证据引用 | 被当作"当前认知"直接陈述 |
| **current** | `facts`、`character_facts`、`basics`、人格证据、纠正候选 | 只读 `active && 未过期` | 读全量 |

落地方式（最小改动，不重构存储）：

1. `ProfileStore` 增加唯一的**当前态**出口（`getCurrentFacts()` / `getCurrentCharacterFacts()`），
   语义等同今天的 `getActiveFacts()`，**但所有读取出口只许调它**。
2. `getAllFacts()` **保留但改名语义**：文档标注「**仅审计/调试**」，并加一个检查脚本
   禁止它在 `processors/`、`engines/` 被调用（白名单：`ProfileStore` 自身、`MemoryManager` 的审计方法、测试）。
3. **`deepProfile` 改读当前态**（E2）。若当前态为空：不改写 `basics`、记 warn，并把 `basics` 标 stale。
4. **历史摘要不重写**（用户明确"不必立即重写"）：摘要就是历史，它记录"当时聊了什么"。
   一旦某条事实失效，**只有 `current` 档的出口需要跟着变**。

### C3 派生结果可追溯、可重建

1. `basics` 由 `current facts` 派生，写入时同时记谱系：
   `user_profile.basics_source`（JSON：`{ factKeys: string[], generatedAt, factCount }`）。
2. **失效传播**：`supersede` / `expireFact` / `expireStaleFacts` / `confirmFact(false)` / `replaceFacts` 任一次状态变化
   ⇒ 置 `basics_stale=1`（**不立即重建**，成本太高；由 cron 或手动触发）。
3. `PromptAssembler` 的**三档处置**（apply 时按"纠正之后她真的不再坚持旧说法"这条产品判据细化过）：
   - 新鲜 → 正常注入 `[关于你]`
   - **过时且有当前事实 → 整块不注入**：事实块会以"当前认知"的身份说同一件事，
     而 stale 的旧总结只会和新事实打架（"他在长沙" vs "他在深圳"）。
     ★ 这一条是提案初稿（"降级标注 + 事实块优先"）的**收紧**：标注挡不住模型照着旧总结答。
   - 过时且**一条当前事实都没有** → 降级注入 `[关于你（较早的印象，可能已过时）]`
     （没有事实块兜底时仍要给底色，但必须标明它旧）
4. 新增公开方法 `rebuildBasics(): Promise<{ ok, usedFacts, stale }>`（纯数据返回）——
   这就是"可重建"的执行入口，也是 Web 端"重建画像"按钮的落点。
5. 向量侧最小口径：`metadata` 增 `derived_from: 'event' | 'summary'`（今天混在一起看不出来源），
   文档记明「向量是派生、不是真相」。

### C4 各阶段独立记录结果（分段成功、分段补偿）

1. `SessionEndResult` 扩成三段：

```ts
{ summary: 'ok' | 'failed' | 'skipped', facts: 'ok' | 'failed' | 'skipped', vector: VectorWriteOutcome, reason?: string }
```

2. `conversations` 增列 `facts_status`（`'ok'|'failed'|'skipped'|'pending'`），与 `summary_status` 并列。
   ⚠️ **默认值必须写 `'pending'`/`'failed'`，不许沿用 `'ok'`**（KI-17 的教训：默认 'ok' 会让漏传变成静默成功）。
3. `SessionEndProcessor`：事实提取**失败要如实写 `facts_status='failed'`**（不再"提取空就当成功"）；
   同步把"提取成功但 0 条"与"提取失败"区分开（前者 `'ok'` + 计数 0，后者 `'failed'`）。
4. 新增 `retryFailedFactExtraction(limit)`：按 `facts_status='failed'` 的窗口重跑**只有事实提取**
   （不重摘摘要、不重写向量）。这是 `retryFailedSummaries()` 的对称物。
5. `onSessionEnd()` 返回 `SessionEndResult`（不再是 `void`）；`chat.ts` / dsh 结算 / Web 端按真相打日志与回执（E6）。
6. `retryFailedSummary` 改走 `eligibility.ts`（E1）—— 同一窗口两次摘要**条件必须一致**。

## 4. 明确不做

- ❌ **不换架构、不加记忆层、不引图数据库**（用户已定：单用户产品，SQLite + LanceDB + 一个 Manager 够用）
- ❌ **不动存量数据**（存量怎么处理另行确认；本 change 只保证"从此往后判据唯一"）
- ❌ **不重写历史摘要**（历史就是历史；只保证 current 档不再引用失效内容）
- ❌ **不调召回系数、不新增人格参数**（那是 `tune-recall-with-runtime-data` 的事，且仍等数据）

## 5. 离线场景验证（不能只靠"模块齐全"）

代码审查只能证明**规则一致**，证明不了**记得准、提得自然**。因此本 change 附带一组
**fixture 回放用例**（`packages/core/tests/memory/eligibility-scenarios.test.ts`，不调真实 API）：

| 场景 | 判据 |
|---|---|
| S1 纠正生效 | 用户纠正后，`assemble()` 输出**不含**旧说法 |
| S2 她的话不调人格 | 只灌 assistant 事件 ⇒ `persona.adaptation_hints` 零新增 |
| S3 合成注入旁路 | 正常摘要与**补处理**两条路径都不含注入文本；`facts` 侧 `fromSynthetic == 0` |
| S4 事实失败的补偿 | 摘要成功 + 提取失败 ⇒ `facts_status='failed'`，重试后事实补齐 |
| S5 basics 只据当前态 | 构造 `superseded` 事实 ⇒ 它不出现在 `basics`，且 `basics_source.factKeys` 不含它 |
| S6 不自证 | 反思产出的 `character_fact` 不进人格证据链（取决于 D2） |

## 6. 已拍板（2026-10-21）

| # | 问题 | **结论** | 影响 |
|---|---|---|---|
| **D1** | `assistant` 事件是否退出人格证据链 | ✅ **完全退出**：仍进摘要与向量（要能回忆"聊过什么"），但**不调人格、不做纠正**。人格只由"你怎么对她"驱动 | 人格扫描量下降；需一条反向用例（同样文本换 `role:'user'` 必须有 hint，证明是闸起作用而不是文本没命中） |
| **D2** | 每日反思产出的 `character_fact` 算不算人格证据 | ✅ **只进【关于我】，不算人格证据**：`source='reflection'`，保留自我叙事，切断"自证 → 自改"闭环 | 连续 3 天反思 ⇒ 人格参数零变化 |
| **D3** | `facts_status='failed'` 的自动重试上限 | ✅ **每窗口 1 次**（cron 触发），仍失败就留在 `failed` 可见、可手动再补 | 防止 22 天那种"每轮重试、每轮失败、日志全绿" |

⚠️ D1/D2 的共同判据：**她自己产出的内容可以形塑表达，不可以形塑权威。**
越自主运行，这条越重要——否则"她认为的你"会由"她说过的你"自己长出来。

## 7. 对账方向确认

- [x] `memory-system` spec **未声明**记忆资格/有效性两档 ⇒ 本 change **新增**章节（不是抹掉设计意图）
- [x] 与 `filter-synthetic-context-inflow`（KI-20）**不冲突**：那条只改摘要/实时两处行为，本 change 收口判据来源
- [x] `docs/Web-API-Design.md` **需要更新**：`onSessionEnd` 返回类型变化 + 新增 `rebuildBasics`
- [x] 新增 `docs/KNOWN-ISSUES.md` 登记？**否** —— 本 change 就是原处（7 条证据即登记）；只回 `docs/TODO.md` 加一行导航
- [x] 涉及 DB 迁移：`conversations.facts_status`、`user_profile.basics_source`、`basics_stale`
      （全部 `addColumnIfMissing`，默认值不算"成功"）

## 8. 验收（可机器判定）

1. `grep -rn "getAllFacts\|payload.synthetic\|skip_profile" packages/*/src` 的命中点**全部在白名单内**，
   加法：`scripts/check-memory-eligibility.cjs`（越界即 exit 1），接进 pre-commit。
2. E1–E7 各有**一条先红后绿**的用例。
3. S1–S6 六个场景全绿。
4. 全量测试不低于现基线（详见 `docs/HANDOFF.md` 顶部），Node 24 跑。

## 9. 风险与代价

| 风险 | 缓解 |
|---|---|
| 判据收紧后事实来源变少（尤其纠正只认 user） | 上线后看 30 天 `[Eligibility] skip` 分布；宁可少记，不可记错 |
| `basics_stale` 降级可能让她"想不起你" | 事实块仍在（`[关于你的事实]`），只是不复述过期总结 |
| 新列迁移在线上老库出错 | `addColumnIfMissing` + 迁移测试（`conversation-summary-status.test.ts` 有现成范式） |
| 场景用例是 fixture，可能过度拟合 | 每条场景附一句"真实数据下如何验证"（E2E 留 `tests/memory/e2e/`） |

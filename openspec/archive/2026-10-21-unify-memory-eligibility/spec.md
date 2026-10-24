# Spec 变更：unify-memory-eligibility

> **说明**：本文是**可整节插入**的完整 spec 文本，供 apply 阶段合并回
> [`openspec/specs/memory-system/spec.md`](../../specs/memory-system/spec.md)。
> 合并时**逐节插入，不带 `+` 前缀**（`+` 只在本文件里示意"这是新增内容"，
> 但为避免 archive 前的残留检查误伤，本文件**不写**行首 `+`）。
>
> 插入位置：
> - §A → `memory-system` §3（调度流程）末尾，成为 **§3.5 记忆资格**
> - §B → §4（引擎）末尾，成为 **§4.6 有效性与派生谱系**
> - §C → §5.4（摘要窗口）之后，成为 **§5.4.4 分账与补偿**
> - §D → §7（错误处理）新增小节
> - §E → §9 变更记录

---

## §A 记忆资格（新增，插在 §3 之后）

记忆系统的所有"学习"动作（写事实、调人格、做摘要、生成向量）都必须先回答同一个问题：
**这条内容，允许用于这个用途吗？** 答案只有一处。

**契约 1：来源 × 用途矩阵是唯一的资格判据，实现于 `memory/eligibility.ts`。**

| 来源 | `profile-facts` | `persona-evidence` | `correction` | `summary` | `embed` | `worldbook` |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `user` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `assistant` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `self-life` | ❌ | ❌（mood 漂移走 `adjustFromMood`，不读文本） | ❌ | ❌ | ✅ | ✅ |
| `engine` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `agent-delegated` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `synthetic` | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `npc` | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| `tool` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| `unknown` | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

来源判定**顺序即优先级**（实现见 `originOf()`）：非 `message` → `tool`；
`synthetic`/`dsh_origin` → 机器来源；`role:'engine'` → `engine`；`skip_profile` → `npc`；
`role:'user'`（或老数据 `sender_id`）→ `user`；`perspective:'self'` → `self-life`；
`role:'assistant'` → `assistant`；其余 → `unknown`。
⚠️ 机器标记**优先于 role**：合成注入恰好以 `role:'user'` 入库，这就是 KI-20 的成因。

为什么 `assistant` 允许 `summary`/`embed` 却禁止 `profile-facts`/`persona-evidence`：
她说过的话是**对话历史**（"我们聊过什么"要能回忆），但**不是关于用户的证据**，
更不是"用户对她的反馈"。把两者混起来，她会因为自己说过的话改变自己。

**契约 2：处理器内禁止自带资格 `if`。**
`payload.synthetic` / `payload.skip_profile` / `payload.role` 的**判定逻辑**只允许出现在
`eligibility.ts` 与 store 层 SQL（性能原因），其余位置必须调 `isEligible()`。
由 `scripts/check-memory-eligibility.cjs` 机器拦住（非 0 不许归档）。
已知的 SQL 侧重复点：`EventStore.getLastUserMessageAt`（白名单，注释指向本契约）。

**契约 3：跳过必须留下 `reason`。**
`isEligible()` 返回 `{ ok, reason }`；`reason` 进日志（限频），
**"滤掉了"与"本来就没采到"不许长得一样**（KI-20 那条闭环能悄悄跑很久，正是因为它没有 reason）。

**契约 4：两条摘要路径的资格条件必须逐字相同。**
正常摘要与补处理（`retryFailedSummary`）必须共用同一个 `dialogueOf()`。
文档化理由：同一窗口"第一次滤掉、第二次收进去"是**最坏的一种不一致**——它让错误变成可复现但难解释。

---

## §B 有效性与派生谱系（新增，插在 §4 之后）

**契约 1：读取分两档，不许混用。**

| 档 | 内容 | 语义 |
|---|---|---|
| **historical** | `events`、`conversations.summary`、向量 | 历史记录：**不可改写**，可作证据引用，**不得**被当作"当前仍然成立"直接陈述 |
| **current** | `facts`、`character_facts`、`basics`、人格证据、纠正候选 | 当前认知：只有 `status='active'` 且未过期的条目算数 |

**契约 2：`current` 档只有一个出口。**
`ProfileStore.getCurrentFacts()` / `getCurrentCharacterFacts()`。
`getAllFacts()` **降级为审计专用**，`processors/` 与 `engines/` 内**禁止**调用（脚本拦）。

依据：`CronProcessor.deepProfile` 曾用全量事实重写 `basics`，
于是被用户纠正掉的旧说法会**换一个形式（`basics` → `[关于你]`）回到 prompt 里**。
"源头改对了"不等于"所有出口都不再使用旧信息"。

**契约 3：`basics` 必须带谱系，且可失效。**
写入 `basics` 时同时写 `user_profile.basics_source = { factKeys, generatedAt, factCount }`，
`factKeys` 是**当次实际喂给 LLM 的**事实键，不是全量。
任何事实状态变化（`supersede` / `expire` / `confirm(false)`）⇒ `basics_stale = 1`。

**契约 4：失效**不触发**同步重建，只触发 stale。**
- 成本：重建要调 LLM，不能挂在写入路径上
- 触发点：`supersede` / `expireFact` / `expireStaleFacts` / `confirmFact(false)` / `replaceFacts`
- 注入侧三档（服务"纠正之后不再坚持旧说法"这条产品判据）：
  1. 新鲜 → 注入 `[关于你]`
  2. **过时且有当前事实 → 整块不注入**（由事实块承载当前认知）——
     标注挡不住模型照着旧总结答，"他在长沙"与"他在深圳"同时在场就是让它二选一
  3. 过时且无当前事实 → 降级注入 `[关于你（较早的印象，可能已过时）]`
- 重建：`MemoryManager.rebuildBasics()`（cron 每轮/Web 端可手动触发），成功后清 stale 并写谱系

**契约 5：向量是派生，不是真相。**
`metadata` 必须记 `derived_from`（`'event'` | `'summary'`）。
向量只回答"哪段内容与这次提问相关"，不回答"这条事实是否仍然成立"——
后者只能由 `current` 档判定。

**契约 6：历史摘要不因事实失效而改写。**
摘要记录"当时聊了什么"。用户可以纠正一条事实，但**不能要求过去的对话没发生过**。
需要区分的是**读取出口**，不是重写历史。

---

## §C 分账与补偿（新增，插在 §5.4 之后）

**契约 1：一次结算的三个产物分别成功、分别记录。**
`SessionEndResult = { summary, facts, vector, reason? }`，
三者互不冒充（承接 KI-15 的 `vectorOutcome`，并把 `facts` 补上）。

**契约 2：`conversations.facts_status` 的默认值是 `'pending'`，不是 `'ok'`。**
依据：KI-17 的教训——默认 `'ok'` 会把"漏传"变成静默成功。
`facts_status ∈ { 'ok', 'failed', 'skipped', 'pending' }`；
`'ok'` 且计数为 0 表示"看了，确实没有新事实"，与 `'failed'` **含义不同**。

**契约 3：事实提取失败不得被"已处理"吞掉。**
`ProfileExtractor` 必须区分**失败**与**提取 0 条**；
失败时 `facts_status='failed'`，且该窗口的事实提取**可被重跑**
（`retryFailedFactExtraction()`，与 `retryFailedSummaries()` 对称：只补事实，不重摘摘要、不重写向量）。

依据：摘要成功 ⇒ 锚点前进 ⇒ 该窗口再也不会被 `getBySession` 捞到，
而事实提取的失败当时只留下一行 error 日志 ⇒ **这批事实永久丢失且无人可见**。

**契约 4：重试有上限，用尽后留在 `failed` 且可见。**
每个窗口最多重试 1 次（D3 拍板值）。防止"每轮重试、每轮失败、日志全绿"。

**契约 5：调用方不得把"跑完了"打印成"成功了"。**
`onSessionEnd()` 返回 `SessionEndResult`；
任何回执/日志（CLI、Web、dsh 结算）必须按 `summary/facts/vector` 三段分别如实陈述。

---

## §D 错误处理（新增小节，插在 §7）

**契约 1：`current` 档读到空 ≠ 用户是新朋友。**
`deepProfile` 遇到"当前态为空"时**不改写** `basics`（避免把旧印象洗成空白），
记 warn 并置 stale；由下一次有事实时重建。

**契约 2：跳过必留 reason，失败必留 tag。**
资格跳过用 `[Eligibility]`，阶段失败用 `[SessionEnd]`/`[Cron]` 既有 tag，
两者都走 `warnThrottled`（避免每条消息刷屏，见 KI-20 的噪声教训）。

**契约 3：只加列、不改语义；新列默认值不得表达"成功"。**

---

## §E 变更记录（追加到 §9）

| 日期 | change | 内容 |
|---|---|---|
| 2026-10-21 | `unify-memory-eligibility` | 新增 §3.5 记忆资格（来源×用途矩阵）、§4.6 有效性与派生谱系（historical/current 两档、`basics` 谱系与 stale、`rebuildBasics`）、§5.4.4 分账与补偿（三段结果、`facts_status`、`retryFailedFactExtraction`）、§7 三条错误处理契约 |

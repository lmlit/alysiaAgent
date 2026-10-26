# PLAN 2026-10-24 — 上下文一致性与「规则可达性」

> **本文是工作清单，不是契约。** 正文权威在各 change / KI 里，本文只负责"一眼看完在办什么"。
> 建立于 2026-10-24，起因：拿 `dsh-bili-whale`（v0.4.6）做对照时,发现我们自己这套
> **结构更细,但有若干条「规则写了却永不触发」**,以及**同一份数据被多套代码各解释一次**。
>
> 纪律不变：**任何一条要动代码，先开各自的 change**（`openspec/project.md`）。
> 本文里的 P 编号**不是**正式 ID，只是本轮的沟通编号；正式 ID 用 change 名 / KI-xx。

---

## 0. 一句话总纲

我们相对 whale 的差距**不在机制数量**，在**规则的可达性没有任何验证手段**：
测试只证明"不该发生时没发生"，从没证明"该发生时确实发生"。
下面每一条，本质都是这个病的不同形状。

---

## 0.5 ⚠️ 方向变更（2026-10-24 晚，用户决定）

> **「dsh 的昔涟模式基本不用了，重心不放在这里，并先切断它对记忆系统的影响。」**

| 影响 | 处置 |
|---|---|
| **dsh 通道** | `alysia-adapter.config.bridge: false` —— 停 `ingest` + **会话结算**（后者会改画像与人格）。只切「写」，`recall_memory` 与人格注入保留 → change [`cut-dsh-memory-bridge`](../openspec/archive/2026-10-24-cut-dsh-memory-bridge/proposal.md)（**已归档**） |
| **P1（dsh 世界书注入）** | **降级为卫生修复**：代码与测试保留（真实缺陷已修），但**取消**内容迁移（决定 2）与真机验收；`/api/memory/read` 不再被 dsh 调用 ⇒ 新字段生产上不再使用 |
| **P9（`pipelineMode` 无写者）/ P10（人格 3.5 份）** | 仍成立，但与 dsh 无关的 P10 保留优先；P9 视 dsh 存废再定 |
| **历史数据** | **不清理**（用户：「已写入的就先不管了，问题不大」） |
| **重心** | 移回与 dsh 无关的四项：**P2/P3（亲密度衰减可达性）✅ → P8 第 1+3 步（context-facts）✅ → P10（人格第三份）✅ → 隐私模式 ✅（P12）→ 采样槽（P8 第 4 步）** |

---

## 1. 在办清单

| # | 条目 | 状态 | 权威出处 |
|---|---|---|---|
| **P1** | dsh 的 `mode` 一词三义：世界书 scope / 提示块表 / token 预算，导致世界书在 dsh 里**双路皆断** | ✅ **已归档**（2026-10-24）→ ⚠️ 随方向变更降级为卫生修复：代码留、内容迁移与真机验收取消 | [`archive/2026-10-24-align-dsh-memory-blocks-with-scope`](../openspec/archive/2026-10-24-align-dsh-memory-blocks-with-scope/proposal.md) |
| **P11** | dsh 通道仍在往记忆系统**写**（`ingest` + **会话结算会改画像/人格**） | ✅ **已归档**（2026-10-24）：`bridge: false`，只切写；⏳ 等 dsh 重启生效 | [`archive/2026-10-24-cut-dsh-memory-bridge`](../openspec/archive/2026-10-24-cut-dsh-memory-bridge/proposal.md) |
| **P2** | 亲密度「无互动衰减」在默认旋钮下**永不触发**（可见窗口 7 天 < 阈值 8 天）—— ★ 查实：**是 `07c9016`（08-07）那次"旋钮接线"修复把它弄坏的**（阈值 3 → 8，窗口一直是 7） | ✅ **已归档**（2026-10-24）：1868 全过 + 反向自检变红 | [`archive/2026-10-24-prove-intimacy-decay-reachable`](../openspec/archive/2026-10-24-prove-intimacy-decay-reachable/proposal.md) |
| **P3** | 「最后一条真人消息」有**两份判据**，其中一份不排除 `synthetic`/`skip_profile` | ✅ 已收敛（同一方法 `idleSinceLastUserMessage()`） | 同上 |
| **P8** | **组装器/事实层切面化**：抽事实层 / 块注册表 / 体裁表 / 通用装配器。四步各自独立收益 | 👤 已拍板 · **第 1+3 步已完成并归档**（`converge-context-facts`：事实层收敛 + 问候补档位/idle）；**第 2 步已归档**（`assembler-block-registry`）；**剩第 4 步**（`genres`） | [`archive/2026-10-24-converge-context-facts`](../openspec/archive/2026-10-24-converge-context-facts/proposal.md) |
| **P9** | `pipelineMode` **有字段、有读者、没有写者** ⇒ `assembleCode` 在生产链路**不可达**（"编程模式组装"只存在于单测里） | 🧑 待拍板：接线 / 标死 / 删 | 本文 §2.7 |
| **P10** | 人格实际有 **3.5 份**：`proactive.ts:45` 有一行**未登记的内联人格**（`label-dual-persona-sources` 只覆盖了 2 份） | ✅ **已归档**（2026-10-24）：身份/语气改取 DB，体裁约束留常量 | [`archive/2026-10-24-unify-greeting-persona-source`](../openspec/archive/2026-10-24-unify-greeting-persona-source/proposal.md) |
| **P12** | 隐私模式三档**从没兑现**：eadonly 只挡注入、不挡学习（画像照提取 ⇒ 下次对话照样被引用）；//privacy 命令从未注册；reset 是内联赋值（命名方法是死代码，且任何会话结束都清） | ✅ **2026-10-25 已归档**（ulfill-privacy-mode）：eadonly 打 skip_profile、补 /privacy 命令、reset 按 privacySessionId 收口 | [rchive/2026-10-25-fulfill-privacy-mode](../openspec/archive/2026-10-25-fulfill-privacy-mode/proposal.md) |
| **P4** | `{{alysia_life}}` 在 dsh 里**恒为空**（注册了，回调固定 `return undefined`） | 🧑 待定（**严重度已下调**，见 §2.5） | spec §2.3 / §4 |
| **P5** | 生活事件上下文**不含任何用户画像**（是否设计意图待确认） | 🧑 **待澄清**——可能是**故意的** | 本文 §2.3 |
| **P6** | 「沉默 → 少说话」缺一条**表态时钟**驱动的衰减帽 | ✅ **2026-10-25 已落地**（`worth-telling-and-silence-clock`：`silenceCap(3/7)` + 三处 `min`；数值保守起点、日志可调） | [`archive/2026-10-25-worth-telling-and-silence-clock`](../openspec/archive/2026-10-25-worth-telling-and-silence-clock/proposal.md) |
| **P7** | `unify-memory-eligibility` 代码已在 `feat/dsh-bridge-cut`（`9fd017e`） | ✅ 代码已并入当前分支；只剩「合 master」（2026-10-26 处理） | [TODO.md](TODO.md) |

> 📖 **现状底账**：[`PROMPT-INVENTORY.md`](PROMPT-INVENTORY.md) —— 17 条链路各注入了什么、
> 两张块表逐块、静默断点 6 条。**改任何一条链路前先看它**，别再造第四份同一事实。


---

## 2. 每条的证据与处置

### 2.1 P2 — 亲密度衰减不可达

> ★ **2026-10-24 追加查证：这不是"没修过"，是"修的时候弄坏的"。**
>
> | 提交 | 改动 | 可达性 |
> |---|---|---|
> | `7f08f73` 初版 | 窗口 `since7d` = **7 天**；条件 `idleDays >= 3` | ✅ 可达 |
> | **`07c9016`（08-07）** `wire memory_config knobs into intimacy calc` | 修「旋钮从未参与决策」：硬编码 → `decayThreshold = 2 + round((1-0.4)×10)` = **8** | ❌ **不可达** |
>
> 窗口从未改动 ⇒ `idleDays` 上限 = 7（兜底还写死 `: 7`），阈值 8 ⇒ 恒假。
> **那次修复做对了它想做的事，顺手把门槛抬过了数据窗口的天花板。**
> `life-service.test.ts:398` 的用例标题就是「5 天…**未过 8 天阈值，不衰减**」——
> 只守「不该触发时不触发」，**这一侧永远绿**。
> 教训已入 [`SILENT-FAILURE.md` §4.3](SILENT-FAILURE.md)（第四形态：**不可达**）。

**证据**（`packages/server/src/life.ts`）：

```ts
const since7d = new Date(Date.now() - 7 * 86_400_000);                  // :1460 只捞 7 天
const msgs = this.memoryManager.getRecentMessages(..., since7d);        // :1461
const idleDays = lastUserAt ? Math.floor((Date.now()-lastUserAt)/86_400_000) : 7;  // :1485
const decayThreshold = 2 + Math.round((1 - (cfg.importance_threshold ?? 0.4)) * 10); // :1466 → 8
if (idleDays >= decayThreshold) { ... }                                 // :1486 永不成立
```

`idleDays` 的**可观测上限 = 7**（窗口 7 天；超出窗口走兜底 `= 7`），默认阈值 **8**。
⇒ `idleDays >= 8` 恒假，**用户一年不说话亲密度也不动**。
只有把 `importance_threshold` 调到 ≥0.5（阈值 ≤7）才可能触发。

**测试盲区**：`packages/server/tests/life-service.test.ts:398` 只有「5 天未过 8 天阈值 → 不衰减」。
**没有一条用例覆盖 ≥8 天**——这正是它空转却全绿的原因。

**处置**：判据改用 `getLastUserMessageAt()`（与窗口解耦，见 P3），补 ≥8 天的用例。
**不调数值**（阈值/幅度等运行数据，见 §3）。

### 2.2 P3 — 两份「最后一条真人消息」判据

| 用途 | 判据 | 是否排除机器注入 |
|---|---|---|
| 亲密度**档位** / 推送闸 idle | `EventStore.getLastUserMessageAt()`（`EventStore.ts:238`） | ✅ `role=user AND skip_profile=0 AND synthetic=0` |
| 亲密度**衰减** idle | `life.ts:1483` `[...msgs].reverse().find(m => m.role === 'user')` 于 `getRecentBySession()` | ❌ `getRecentBySession` 只按 session/type/created_at 过滤 |

这正是 `packages/core/src/memory/eligibility.ts` 头注释点名的「判据四份各答一次」的**第五份**。
**处置**：收进 `isEligible()`，并扩 `scripts/check-memory-eligibility.cjs` 把第五份也拦掉（该脚本已默认拦截同类形态）。

### 2.3 P5 — 生活事件上下文不含用户画像（**待澄清，别当 bug 修**）

`packages/server/src/life.ts:903-936` 那份 context 里**没有任何** `basics` / `preferences` /
`facts` / `characterFacts` / `[相关记忆]` / `[最近对话]`。

但同文件 `:921` 的注释是：

> ★ 8-29 **独立人格**：移除【轻月最近】(她的生活不围绕轻月)——轻月只在 chat 分享/偶发想念中出现

⇒ **很可能是故意的**（她要过自己的日子，不是拿你的画像填她的日记）。
按 `openspec/project.md` 的对账方向：doc 已声明设计意图、impl 与之一致 → **这条不是 gap**。
**待确认**：要不要给她一小块「关于你的稳定认知」（如称呼/禁忌），而不是整套画像。

### 2.4 P6 — 「沉默 → 少说话」的驱动源

现状：主动推送的闸由**亲密度档位**驱动（`INTIMACY_TIERS` + 冷却 + 日上限），
**没有**「距离上次表态多少天」这个时钟。whale 那套是**表态时钟**驱动分享额度（3 天开始降 / 7 天归零）。

⚠️ **不要照抄它的数值**：它的 3/7 天管的是「分享额度」（发言频率），我们的 8 天阈值管的是
「亲密度」（关系温度）——**两个不同的量**。可借的是**形状**：

1. 表态时钟（`feedback.last`：回她/赞她/让她做事都算）→ 独立于亲密度的**第二根轴**
2. 分三档 → 每档换成第一人称处境（我们现在只有 `distant` 档的「问一次」，见 `life.ts:391`）
3. 「他回来了」转折（**已有**，`life.ts:397`；whale 也有，同一手法）

**✅ 2026-10-25 已落地**（`worth-telling-and-silence-clock`）：`silenceCap(idleDays, quiet=3, mute=7)`
是纯函数（放 `context-facts.ts`），`life` 推送门三处取 `min(配置, 档位 cap, 沉默 cap)`，
沿用「只降不升」；**不动亲密度衰减速率**（那是另一件事）。数值是保守起点、不照抄 whale，
每次真正生效都打日志，攒数据后再调。下面保留立项时的论证。

---

### 2.5 P4 — `{{alysia_life}}` 恒空（**严重度已下调，2026-10-24 更正**）

初判"dsh 里她没有今天的生活"**是错的**。`/api/memory/read` → `assembleWithWorldbook()` 内部会调
`getLifeEventInjection()`（`MemoryManager.ts:1253`），所以 `[我的近期日常]` **确实随记忆块进了 dsh**。

真实情况：`{{alysia_life}}` 是**第二条冗余入口**（dsh 模板变量），注册了但回调固定
`return undefined`（`dsh-adapter/src/index.ts:187`，注释写"二期"）。

⇒ 危害不是"她看不到自己的生活"，而是**"一个声称存在的入口是空的"** —— 下一个读 spec 的人
（包括三个月后的我们）会把它误诊成"生活事件注入没做"。**处置二选一**：填上它，或**删掉这个变量**
（与"删死配置"的既有纪律一致）。

---

### 2.6 P8 — 组装器切面化（👤 已拍板，四步独立）

**为什么要做**：`PromptAssembler` 是**唯一没有被切过的那块**。同仓已有先例——
`eligibility.ts`（四份判据收成一份）、`importance.ts`、`project-task-window.ts`、
`self-notice.ts`、`render-dialogue.ts` 都是从内联代码里切出来的纯函数模块。
组装器没切，于是每次加一条链路只能**复制整个函数**。

**四个硬不兼容**（不是"当时没选它"）：

| # | 原因 | 证据 |
|---|---|---|
| 1 | 输出是**已渲染整串**，没有成分 | `return blocks.join('\n\n')` |
| 2 | **措辞里嵌了体裁** | `[待确认的事实]`＝「合适时机自然地问」；`brevity`＝「像发微信」 |
| 3 | **读伴随写** | `listPendingConfirmFacts()` 首行 `expireStaleFacts()`（`ProfileStore.ts:473`）|
| 4 | **预算/策略/顺序写在函数体** | `new TokenBudget(3200)` + `CHAT_BLOCK_POLICY` + if 语句顺序 |

**四个切面**：

```
store → ① context-facts.ts   事实层：纯数据、唯一判据、零副作用（吸收 P2/P3）
      → ② block-registry.ts  块注册表：加块不改装配器 + 声明 effect: read|write
      → ③ genres.ts          体裁表：预算 / 采样 / persona 节数 / forbids
      → ④ assemble()         通用装配器（assembleChat 变成它的薄包装）
```

**四步（每步独立收益，可随时停）**：

| 步 | 动作 | 行为是否变 | 兜底 |
|---|---|---|---|
| 1 | 抽 `context-facts.ts`，先只让 `assembleChat` 用它 | **不变** | `prompt-assembler-characterization` 快照逐字比 |
| 2 | 抽 `block-registry.ts`，12 块改成注册项 | **不变** | 同上 + 丢块日志逐字比 |
| 3 | 让 `life` / `greeting` 改用 facts | **变**（= P2/P3 的修复） | ≥8 天用例 + 四档测试 |
| 4 | 8 个体裁进 `genres.ts` | 结构变 | 各体裁 prompt 快照 |

**三个别踩的坑**：
1. 体裁**别做成布尔**（`includePersona/includeBrevity`… 4 个布尔 = 16 种组合，12 种非法）
   → 用 genre 枚举 + `forbids` 白名单，非法组合根本表达不出来
2. 事实层**只返回数字，不返回句子**（否则措辞又写死在一处）
3. **别硬统一**：`session-summary` / `reflection` / `profile-extract` 要的是**原始消息**，
   不共享事实层，只共享体裁声明（预算/采样/prompt 资产）

**与其它条目的关系**：P2/P3 = 第 1 步；P1 在第 2 步之后做会更简单（`blocks='chat'` 就是
"用 chat 那组注册项"）；P4 有了 facts 之后填或删都是一句话。

### 2.7 P9 — `pipelineMode` 没有写者 ⇒ `assembleCode` 不可达

**证据**：全仓 `pipelineMode` 只出现三处——`event.ts:44` 默认值 `'chat'`、
`EventBus.ts:93` 打日志、`memory-retrieval.ts:30` 读它。**没有任何一处赋 `'code'`。**
（`codeMode` 是另一个东西：只门控 shell/filesystem 工具注册，`capabilities.ts:198`。）

⇒ 生产链路里 `assembleCode` **一次都没跑过**，只有单测 `mm.assemble('code')` 和
手工 `POST /api/memory/read { mode:'code' }` 能到。

**这不是"小事"**，因为它意味着 `CLAUDE.md` 里那句
「`MessageEvent.pipelineMode` — 'chat'|'code' 控制 Prompt 组装模式」是**doc 声明、impl 没接**。
按对账方向规则：要么接线（改 impl），要么把它标成"仅测试可达"（改 doc）。
**别让它继续以"已支持"的样子存在**——dsh 那个 bug 就是这么长出来的。

### 2.8 P10 — 人格实际有 3.5 份

| 份 | 位置 | 谁会读到 |
|---|---|---|
| ① 正式人格 | DB `persona.system_prompt` → `getCompactPersonaPrompt()` 切前 4 节 | 聊天管线 |
| ② dsh 人格 | `GET /api/persona/prompt` → `{{alysia_persona}}`（①的同一份，传输形态不同） | dsh |
| ③ **未登记** | `modules/proactive.ts:45` 内联一行「你是昔涟，一个温柔贴心的 AI 伴侣…30-60字」 | **主动问候/节日** |
| ④ 世界观节 | `worldview.md` 的【生活底色】【跨世界之窗】 | 私聊 |

`label-dual-persona-sources`（TODO B5）当时结论是"维持两份"，**③ 是后来或当时就漏的**。
后果：改人格不会改到 ③，问候可能仍是旧措辞。

**✅ 2026-10-24 已修**（`unify-greeting-persona-source`，已归档）：③ **不再是「第二句人格」** ——
`packages/server/src/prompts/proactive.ts` 的 `buildProactiveSystemPrompt(persona)` 从
`getPersonaSnapshot()` 取名字与语气维度（与 `PromptAssembler` 的 persona 块**同源**），
文件里只剩体裁约束。写死的那句被删除，并有**反向测试**钉住「温柔贴心」「AI 伴侣」不许再出现。

★ 遗留认知：**人格仍是"多入口"的**（DB → 聊天 / dsh 浓缩版 / prompt 里的人格块 / worldview 节），
但每个入口现在都**只读 DB 或明确的资产**，没有第二份"手写自我描述"了。
`label-dual-persona-sources` 的"两份"结论**只覆盖了 dsh 那条线**，别把它当成全仓结论。

---

## 3. 明确**不做**的事（防止下次又有人想动）

1. **不调既有旋钮的数值**（四档 24/40/70、1.8/天、0.15、7 天冷却、推送冷却 1h / 日上限 20）。
   没有运行数据 —— `docs/TODO.md` 同类条目全标 ⏳「先补观测再调」。
2. **不把 whale 的 `skipChance=0.3` 搬过来**：我们已有拒绝权（`maybeDecline` 0.15 / 连续上限 2 /
   理由 ≥6 字 / fail-open），语义更完整（她还留理由）。重复加一层只是噪声。

---

## 4. 从 whale 借得到的东西（记下来，别忘）

1. **判据形状**：三条实战撞出来的洞——「输入去重漏了 → 衰减晚 2 天」「两种语义混在一个布尔里 →
   空收件箱当成失败」「取数路径漏了一种形状 → 顶层评论永远查不到」。**改自己的东西前先对照这三条。**
2. **「把约束翻译成第一人称处境」**（打不过它的地方）：我们的 `relationshipBlock()`
   （`life.ts:379`）已经做到了，且更细。**新加的规则必须同时想清楚"她读到的句子是什么"**。
3. **两本日记**：它一本给你、一本只给自己（「偏好校准」写在那本）。我们只有一本
   （`saveDiary`，库注释标明「半公开，进博客独立栏目」）。**这是一个真缺口**，但要不要做是产品决定。

---

## 5. 维护规则

- 每条**进入实现**时：开对应 change，把本文这一行的"状态"改成 change 名。
- 每条**归档**时：删本文这一行，在 commit message 写销账依据。
- 本文超过 30 行量级 → 说明在办的事太多，该拆。

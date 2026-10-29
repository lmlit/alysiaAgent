# PROMPT-INVENTORY — 提示词与上下文现状总账

> status: current
> updated: 2026-10-24
> audience: both
>
> **定位**：回答「**某条链路到底往 LLM 里塞了什么**」的唯一入口。
> 不是设计文档（设计在 `openspec/specs/`），不是待办（在 [`TODO.md`](TODO.md) /
> [`PLAN-2026-10-24`](PLAN-2026-10-24-context-and-rules.md)）。**本文只记现状 + 证据，不写愿望。**
>
> 建立理由：2026-10-24 拿 `dsh-bili-whale` 做对照时，跨四条链路查上下文，
> 每次都得出不同答案——**因为根本没有一处能一次看完**。于是同一轮里我自己说错了三处（见 §7）。

## 0. 怎么用

| 你要做的事 | 用本文哪节 |
|---|---|
| 改某条链路的提示词 | §2 找到它 → 看它和谁共享同一份素材 |
| 新加一条链路（新体裁） | §2 登记 + §8 的四个必答问题 |
| 怀疑某块没生效 | §6 静默断点清单 |
| 想抽/改共享数据 | §4 同一事实的多处实现（**先看这里，别写第四份**） |

---

## 1. 三层结构（所有对话类链路的共同形状）

```
① 静态层   活跃角色 persona.system_prompt → getCompactPersonaPrompt() 切前 4 节
            （`\n---\n` 分隔；DB 里那份可能 6375 字）
              ↓
② 数据层   PromptAssembler.assembleChat() → 一段纯文本 → 挂成 `## 当前记忆`
              ↓
③ 运行层   llm-agent.ts 按 messageType / extra 条件追加：
            [当前时间] / [工具调用纪律] / ## 最近对话(10条) / [群聊提醒]
            [生活底色] [跨世界之窗] [此刻的你]（私聊）/ [意图使用] / [表情包使用]
            ## ⚠️ 这一轮不是用户发来的消息（subagent_result）
```

⚠️ **`assembleChat` 只负责 ②**。它不做召回、不做世界书匹配、不看时间——那些都在外面。

---

## 2. 路径总表

| # | 路径 | 谁触发 | 组装方式 | 注入素材 | 预算 | 采样槽 | prompt 资产 |
|---|---|---|---|---|---|---|---|
| 1 | **chat**（QQ私聊/群聊/console） | 用户消息 | `MemoryRetrievalStage` → `assembleWithWorldbook('chat')` → `assembleChat` | **13 块**（§3.1）+ 运行层 | 3200 | `DEFAULT_SAMPLING.chat` | `getCompactPersonaPrompt()` + `CHAT_BREVITY_DIRECTIVE` |
| 2 | **code**（自家 pipeline） | ⚠️ **生产无人调用**（见 §6.3） | `assembleCode` | 6 块（§3.2） | 2450 | 同上 | 压成 1 行的 persona |
| 3 | **dsh 会话** ⚠️ **通道已休眠**（2026-10-24 `bridge: false`，见 §6.7） | dsh agent loop | ① 模板变量 ② context provider ③ 变量（空） | ① `{{alysia_persona}}`＝`GET /api/persona/prompt`（**仍在**） ② `alysia:memory`＝`POST /api/memory/read`（**已不再被调用**：`bridge:false` 后缓存不填充，provider 返回空） ③ `{{alysia_life}}` **恒空** | ②的预算 = 3200 | — | ①②③ 之外的 system prompt **由 dsh 自己拼，我们看不到** |
| 4 | **subagent 结果唤醒** | `core.scheduler.execute` | 走完整 chat 管线 | 同 #1 + `## ⚠️ 这一轮不是用户发来的消息` | 3200 | `chat` | 同上 |
| 5 | **生活事件**（她的一天） | `LifeService.tick`（`nextEventAt`） | **手拼** `life.ts:903-936` | 16 段（§5.1）；**无**用户画像、**无**相关记忆、**无**最近对话 | 无（不设预算） | `life.generateEvent` **temp 0.9** | `LIFE_EVENT_PROMPT` |
| 6 | 每日摘要 | 同上 | 手拼 | 当天事件 + 摘要 | — | `life.generateSummary` **0.3 / 2048** | `LIFE_SUMMARY_PROMPT` |
| 7 | 每日反思 | 同上 | 手拼 | 一天的事件/对话/心情 | — | `0.3` | `LIFE_REFLECTION_PROMPT`（JSON） |
| 8 | 每日日记 | 同上 | 手拼 | 事件 + 近三天摘要 + 心情 + **上一篇最后一句** | — | `0.3` | `LIFE_DIARY_PROMPT`（**纯文本，禁 JSON**） |
| 9 | 每周信 | 同上 | 手拼 | 7 天事件 | — | `0.3` | `LIFE_LETTER_PROMPT`（可回 `NONE`） |
| 10 | 拒绝理由 | `maybeDecline` | 手拼 | 当前处境 | — | `0.3` | `LIFE_DECLINE_PROMPT` |
| 11 | 意图裁决（承诺兑现/延期/取消） | `processDueIntents` | 手拼 | 到期 intent + 近况 | — | `0.3` | `LIFE_INTENT_PROMPT`（JSON） |
| 12 | 心情侧写 | `analyzeMoodNote` | 手拼 | moodValue 序列 | — | `0.3` | `LIFE_MOOD_NOTE_PROMPT` |
| 13 | **主动问候 / 节日 / 关怀** | `ProactiveService.tick` | **`buildProactiveSystemPrompt(persona)`** + 手拼 snippet | 系统提示 = 从 `getPersonaSnapshot()` 取的**名字+语气维度** + 体裁约束；素材 = `contextSnippet()`（近况+今天日常+亲密度档位/idle）**＋ `getRecentDialogueBlock()`** | — | `proactive.personalize` | `prompts/proactive.ts`（2026-10-24 前是**写死在 modules/proactive.ts 的一句**） |
| 14 | 会话结算（摘要/画像/人格确认） | `onSessionEnd` / `/extract` | 直接调 LLM | 会话原文 | — | `session.summary` / `profile.extract` | `SESSION_SUMMARY_SYSTEM_PROMPT` / `PROFILE_EXTRACT_SYSTEM_PROMPT` |
| 15 | cron 深度画像重写 | `al:cron`（6h） | 直接调 LLM | 存量 facts/basics | — | `profile.deepRewrite` | `CRON_DEEP_PROFILE_SYSTEM_PROMPT` |
| 16 | 上下文压缩 | 超限时 | 直接调 LLM | 原文 | — | — | `CONTEXT_COMPACT_SYSTEM_PROMPT` / `…MERGE…` |
| 17 | **隐私模式** | `privacyMode !== 'off'` | `assembleMinimal` | **只有 persona** + 一行「(隐私模式)」 | — | `chat` | 内联 |

**资产清单**（15 个常量，位置固定）：
`core/src/prompts/{chat,context,memory}.ts` + `server/src/prompts/life.ts`（8 个）。

---

## 3. 两张块表（`assembleChat` / `assembleCode`）

### 3.1 chat 表（3200 token，**14 块**）

| 序 | key | 策略 | 数据源 | 副作用 |
|---|---|---|---|---|
| 1 | `selfNotice` | **required** | `self-notice.ts`（看门狗写入的文件） | read |
| 2 | `persona` | **required** | `personaStore.get()` tone/speech/emotional | read |
| 3 | `overlay` | optional | `getOverlayNotes()`（已固化演化） | read |
| 4 | `basics` | optional | `profile.basics`（三档：新鲜 / 过时但有事实→跳过 / 过时且无事实→降级标题） | read |
| 5 | `preferences` | optional | `profile.preferences` | read |
| 6 | `facts` | **required**（2026-10-28） | `getActiveFacts()` 前 20 条 + 组装层去重 + 时间标注 | read |
| 7 | `characterFacts` | optional | `getActiveCharacterFacts().slice(-8)` | read |
| 8 | `pendingConfirm` | optional | `listPendingConfirmFacts()` | ⚠️ **write**（内部 `expireStaleFacts()`） |
| 9 | `pendingConflict` | **required**（2026-10-28） | `listPendingConflicts(1)` | ⚠️ **write**（真正注入后 `markAsked`） |
| 10 | `recentConversations` | optional | `conversationStore.getRecent(3, sessionId)` | read |
| 10.5 | `worldbook` | optional | **仅 `worldbookScope` 显式给出时**才出现（2026-10-24 前是死参数） | read |
| 11 | `life` | optional | 外面的 `getLifeEventInjection()` | read |
| 12 | `memories` | optional | 外面的 `retrieved` | read |
| 13 | `brevity` | **required** | 代码常量（≤3 句，像发微信） | — |

**required 会超预算**：`pushBlock` 对 required 忽略 `reserve()` 返回值（刻意的）。所以 3200 是软上限。
**optional 先到先得**：这就是历史上 `[关于我]` 被整块挤掉的原因（10-15 事故）。

### 3.2 code 表（2450 token）

`persona`(required，压成 1 行) / `techProfile` / `projectContext` / **`worldbook`（只有这张表注入）** /
`life` / `memories`。

⇒ **人味块（basics/preferences/facts/关于我/待确认/待确认冲突/最近对话）在这张表里全不存在**，
    而 `brevity` 也不在。这是 dsh 选 chat 表的原因（见 §6.1）。

---

## 4. 同一事实的多处实现（**想加第四处之前先看这里**）

> 🚫 **2026-10-25 实测更正（change: `make-speech-rules-reachable`）—— 关于 §1 的"静态人格层"**：
> `system_prompt` 共 **42 节**，而聊天只注入 `getCompactPersonaPrompt()` 的**前 4 节**
> （`soul.md` + `identity.md` + `worldview.md`，≈**6697 字**）。
> **`system.md`（第 7 节起）与 `talk_system.md`（第 8 节起）都不在聊天 prompt 里。**
> 聊天规则真正生效的位置是 `packages/core/src/prompts/chat.ts` 的 `CHAT_BREVITY_DIRECTIVE`（`required` 块）。
> ★ 教训：2026-10-24 我写过一轮规则进 `talk_system.md`，并"验证"了 DB 的 `system_prompt` 含这些字
> —— 那只证明**库里那一列有字**，不证明**模型看得到**。**验收要验组装出来的 prompt。**

| 事实 | 实现 A | 实现 B | 差异带来的后果 |
|---|---|---|---|
| **亲密度** | `context-facts.ts` `collectContextFacts()`：**唯一出处**（含档位） | `life.relationshipBlock()` / `proactive.contextSnippet()`：**只排版** | ✅ **已收敛**（change: `converge-context-facts`，2026-10-24）。此前问候只有裸数字 `62/100`，看不出"冷了几天" |
| **用户近况** | 组装层 `facts` 块：去重（`norm`/`normContains`）+ 时间标注（今天/3天前） | `getUserActivitySummary()`：`getActiveFacts()` 按 confidence 取 5 条 join | ⚠️ **仍分歧**：B 绕过去重与时间标注 ⇒ 归 **P8 第 2 步**（`assembleChat` 块注册表） |
| **多久没说话** | `EventStore.getLastUserMessageAt()`：`role=user AND skip_profile=0 AND synthetic=0` ✅ | `life.ts` 的 `idleSinceLastUserMessage()`（**2026-10-24 起**：同一方法） ✅ | ✅ **已收敛**（change: `prove-intimacy-decay-reachable`）。此前衰减侧在 `getRecentMessages(…, now−7d)` 里反查 ⇒ **窗口 7 天把 idle 上限钉在 7，而阈值是 8 ⇒ 衰减永不触发**，藏了 2 个月 |
| **今天的事** | `getLifeEventInjection()`（进 prompt） | `listLifeEvents(1)` 再按本地日期筛（proactive） | 两套筛选口径 |

`eligibility.ts` 头注释已经把这类问题命名为「判据被四份代码各答一次」——**上表是同一类，只是还没收。**

---

## 5. 手拼上下文的两处（不进 Assembler）

### 5.1 生活事件的 16 段（`life.ts:903-936`）

当前时间 / 世界观底色 / 今天是什么日子 / 间隔建议 / 当前状态 / 心情 / 亲密度 /
你和轻月（`relationshipBlock`）/ 今天的生活 / 你的人生背景 / 在场角色 / 你惦记的事 /
上次事件 / 今天已主动联系 / 深夜提示 / 生活切片示范（+ 修正提示、余波任务）

**故意没有的**：用户画像（basics/preferences/facts/关于我/待确认）、相关记忆、最近对话。
依据：`:921` 注释「★ 8-29 **独立人格**：移除【轻月最近】(她的生活不围绕轻月)」，
且 `LIFE_EVENT_PROMPT` 明文写「⑥ 不引用与轻月的对话内容」。
⇒ **这一条是设计意图，不是缺口**（PLAN P5 已按此登记）。

### 5.2 主动问候的 snippet（`proactive.ts:330`）

`用户近况` + `我今天的日常`（≤3 条）+ `我和用户的亲密度`，外面再加
`getRecentDialogueBlock()`（最近对话）和节日/时段指令。
**它有人格 prompt，但是行内写死的**（见 §6.5）。

---

## 6. 静默断点清单（本次核出，**都是"看着生效其实没生效"**）

| # | 断点 | 证据 | 症状 |
|---|---|---|---|
| ~~6.1~~ | ~~**`assembleChat` 的 `triggers` 是死参数**~~ ✅ **2026-10-24 已修** | 原：`PromptAssembler.ts:138` 收参、函数体零引用。现：`worldbookScope` opt-in 注入 + `assembleWithReport().worldbookInjected` | ~~chat/dsh 里世界书一条都不进 prompt~~ → dsh 显式传 `worldbookScope:'code'` 后注入；**QQ 仍不注入（有意，走工具）** |
| 6.2 | **`{{alysia_life}}` 恒空** | `dsh-adapter/src/index.ts:187` `() => undefined` | dsh 侧"生活事件注入"这个入口永远空（但 memory 块里有 `[我的近期日常]`） |
| 6.3 | **`pipelineMode` 有字段、有读者、没有写者** | 全仓仅 `event.ts:44` 默认值 `'chat'`；唯一读者 `memory-retrieval.ts:30` | **`assembleCode` 在生产链路不可达**——只有单测和手工 `POST /api/memory/read {mode:'code'}` 能跑到 |
| 6.4 | **世界书写侧按 code、读侧按 chat** | `RealtimeProcessor.ts:51` `source==='code'→mode='code'` vs `alysia-client.ts:166` 不传 mode | 匹配两次、丢弃一次 |
| 6.5 | **人格实际有 3.5 份**（`label-dual-persona-sources` 只覆盖了 2 份） | ① DB `persona.system_prompt` ② dsh `{{alysia_persona}}`（同一份的传输形态）③ **`modules/proactive.ts:45` 内联一行**「你是昔涟，一个温柔贴心的 AI 伴侣…30-60字」 ④ `worldview.md` 的【生活底色】【跨世界之窗】 | 改人格时 ③ 不会被改，问候可能仍是旧措辞 |
| 6.6 | **`[待确认的事实]` 读伴随写** | `ProfileStore.ts:473` 第一行 `expireStaleFacts()` | 任何复用该块的非对话链路（生活的她）会在意外时机写库 |
| 6.7 | 📌**（不是断点，是有意关闭）dsh 通道已休眠** | `alysia-adapter.config.bridge: false`（2026-10-24，change: `cut-dsh-memory-bridge`） | dsh 不再写 `events`、不再触发会话结算；`alysia:memory` provider 恒空。**「dsh 没有新记忆」是预期，不是 bug** |

---

## 7. 本轮纠正（我 2026-10-24 说错的三处）

| 我说过 | 实际 | 性质 |
|---|---|---|
| 「dsh 里她没有今天的生活」 | `[我的近期日常]` **随 memory 块进了 dsh**；空的是 `{{alysia_life}}` 那个**冗余第二入口** | 严重度判断错 |
| 「主动问候 context 更少、没有最近对话」 | `generateText` 会追加 `getRecentDialogueBlock()` | 事实错 |
| 「编程模式（自家 pipeline）拿 6 块」 | 那条路**生产不可达**（§6.3），属于"写了没接" | 把不可达路径当成在跑 |

**教训**：这三次都是因为"没有一份现状总账"。本文就是为它建的。

---

## 8. 维护规则

1. **新增链路/体裁**必须回本文 §2 加一行，并回答四个问题：
   ① 要不要 persona？要哪几节 ② 要不要 facts？要哪些 ③ 预算多少 ④ 采样哪个槽
2. **新增共享数据**先查 §4：同一事实已有实现就不许写第三份（判据已写在
   `scripts/check-memory-eligibility.cjs` 的模式里，可扩展成机器拦）
3. **本文只记现状**：计划/愿望写 [`PLAN-2026-10-24`](PLAN-2026-10-24-context-and-rules.md)，
   设计意图写 spec。**三者混写 = 三个月后又是一份自相矛盾的文档**。
4. 每次动 `PromptAssembler` 的块表/策略/顺序，同步本文 §3（改块表 = 行为变更，
   必须同时更新 `prompt-assembler-characterization` 快照）。

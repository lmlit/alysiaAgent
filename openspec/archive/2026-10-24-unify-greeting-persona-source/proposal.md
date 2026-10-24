# Change Proposal: unify-greeting-persona-source

## 元信息

- **日期**: 2026-10-24
- **类型**: FIX（人格来源未收敛 —— doc 声明了、impl 用的是写死的一句）
- **状态**: **archived**（2026-10-24 归档。全量 159 文件 / 1887 用例通过）
- **影响 spec**: `proactive-messages`（§2.2 LLM 个性化）
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的 **P10**

## 动机

`proactive-messages` spec §2.2 写着「systemPrompt 固定：**以昔涟身份**生成 30-60 字问候/祝福」。
而实现在 `modules/proactive.ts` 里**写死了一句**：

> 你是昔涟，一个**温柔贴心的 AI 伴侣**。根据要求生成一条简短（30-60字）的个性化问候或祝福…

这一句是全仓**第三份人格**：

| # | 位置 | 谁会读到 | 登记情况 |
|---|---|---|---|
| ① | DB `persona.system_prompt`（`getCompactPersonaPrompt()` 切前 4 节） | 聊天管线 | ✅ `label-dual-persona-sources` |
| ② | dsh `persona.ts` 的 `XILIAN_PERSONA` → `{{alysia_persona}}` | dsh | ✅ 同上 |
| ③ | **`modules/proactive.ts` 内联那句** | **问候 / 节日祝福 / 关怀** | ❌ **无人登记** |
| ④ | `worldview.md` 的【生活底色】【跨世界之窗】 | 私聊 | ✅ 随 §2.1 |

**后果**：改人格不会改到问候；问候可能一直在用一句早就过时的自我描述
（「AI 伴侣」这个措辞也与她现在的定位不符）。

按对账规则：**doc 已声明「以昔涟身份」、impl 没接** ⇒ **改 impl，不改 doc**。

## 需求（做什么）

- [x] 新增 `packages/server/src/prompts/proactive.ts`：
      `PROACTIVE_PERSONALIZE_TASK`（体裁约束常量）+ `buildProactiveSystemPrompt(persona)`
- [x] 身份与语气改为从 `getPersonaSnapshot()` 取：**名字 + formality/warmth/humor/directness +
      sentence_length/emoji_usage + expressiveness/empathy**（与 `PromptAssembler` 的 persona 块同源）
- [x] 删掉写死的「你是昔涟，一个温柔贴心的 AI 伴侣」
- [x] 体裁约束明确三条：**第一人称像发微信 / 不自称「AI」「助手」/ 只输出内容本身**
- [x] `modules/proactive.ts` 改用 builder（`generateText` 里一行）
- [x] `prompts/README.md` 登记该资产（表从 1 行 → 2 行，顺手把 `life.ts` 的段数从 5 更正为 8）

## 设计决策

**不注入完整 compact persona**。实测生产库：`system_prompt` = **36352 字 / 31 节**，
`getCompactPersonaPrompt()`（前 4 节）= **6375 字**。给一条 **30-60 字**的问候塞 6375 字人格，
既不划算（问候一天几次，纯烧 token），也会把"问候"带成"对话"。
这一体裁里「她是谁」由**名字 + 语气维度**承载足够 —— 正是 `PromptAssembler` 的 persona 块用的同一组字段。

**保留「失败回落写死文案」**：问候是锦上添花，人格读不到也不该整条不发
（`buildProactiveSystemPrompt(undefined)` 产出可用文本，名字退化为「她」）。

**不顺手把 `worldview` 也注入**：那是下一层的事，且 greeting 的体裁约束会与之打架（要短）。

## 对账方向确认

- [x] **改 impl，不改 doc**（spec §2.2 的「以昔涟身份」保持，并补记这次收敛的理由与历史）
- [x] 涉及 Web API？**否**

## 测试计划

- [x] `proactive-prompt.test.ts`（5 例）：
      ① 身份/语气来自 DB（逐维度断言）② **「温柔贴心」「AI 伴侣」不许再出现**（防洞里再长草）
      ③ 体裁约束在位（30-60 / 只输出内容）④ 人格缺失/null/空 → 仍可用、无 `undefined`、名字退化为「她」
      ⑤ 语气字段缺失走默认值、无 `NaN`
- [x] 回归：`proactive.test.ts`(32) 全绿（`contextSnippet` 那条链未受影响）
- [x] 全量：**159 文件 / 1887 用例**

## 风险

- ⚠️ 问候文案风格会变（不再被"温柔贴心的 AI 伴侣"框住）—— 这是本 change 的目的。
  若真机上发现问候变得过长/过像对话，调的是 `PROACTIVE_PERSONALIZE_TASK` 里的体裁约束，**不是**把身份写回去。
- ⚠️ 人格参数被 `PersonaAdapter` 改动后，问候会**跟着变**（这正是要的，但也意味着
  人格漂移现在会体现在问候上）；`getPersonaSnapshot()` 读的是当前活跃角色，无缓存问题。

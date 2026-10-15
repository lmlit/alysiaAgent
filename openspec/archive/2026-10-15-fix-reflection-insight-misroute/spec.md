# Spec 变更: fix-reflection-insight-misroute

> **apply 说明**：本 change 给 `ai-life-system` **新增一节** ——
> 「每日反思闭环（life-reflection-loop）的数据落点」。
>
> 该闭环此前**在 spec 里没有任何行为描述**（全篇只有提示词表里一行 `LIFE_REFLECTION_PROMPT`，
> 见 L640），三类回写各去哪、`insight` 属于谁——**全是隐含约定**。这正是落点写错的土壤：
> 提示词说「关于自己」，代码却写进用户画像，而没有任何 spec 条文能指出这是矛盾。
>
> ⚠️ 沿用 `add-theme-system` 起的改法：**不使用 `+`/`-` diff 标记**（理由见 `clean-spec-diff-residue`）。
>
> **位置**：追加到 `ai-life-system/spec.md` 文件**末尾**（现 L650 之后），
> 紧邻已有的「提示词资产」小节。

---

以下为追加内容：

---

## 每日反思闭环（life-reflection-loop）的数据落点

> ★ 2026-10-15 `fix-reflection-insight-misroute` 新增。此前本节缺失，导致 `insight` 落点
> 在代码与提示词之间长期不一致而无人察觉。

`packages/server/src/life.ts` 每日跨天触发一次（`state.reflectionDate` 去重，失败不置位可重试），
LLM 按 `LIFE_REFLECTION_PROMPT` 输出 JSON，经 `MemoryManager.recordReflection()` 回写**三处**：

| 产物 | 落点 | 性质 |
|---|---|---|
| `adjustments` | 人格参数（`adjustPersona`，5 道护栏 + delta 钳制 ±0.05） | 慢变量调整 |
| **`insight`** | **`user_profile.character_facts`（角色画像）** | **她的自我认知** |
| `reflection` | `ai_life_state.reflection`（覆盖式，仅保留最新） | 当次反思原文 |

### 契约 1：`insight` 属于**角色画像**，不属于用户画像

`LIFE_REFLECTION_PROMPT` 的语义是「我悟到的一个关于**自己**的事实」，
其示例原文即「我其实很享受被需要的时刻」。因此 `insight` 必须写入
**`character_facts`**（`PromptAssembler` 以【关于我】块注入），**不得**写入 `user_profile.facts`。

**为什么此前会错**：`recordReflection` 曾调 `profileStore.addFacts()`（用户事实）
并硬编码 `confidence: 0.5` / `category: 'preference'`。线上因此累积 **31 条**错位自省，
特征与硬编码逐一吻合（全部 conf=0.5 / 全部 preference / evidence 全为「每日反思 \<日期\>」），
同时 `character_facts` **长期为 0 条**——她读不到自己积累的自我认知。

**同理**：`category` 不得硬编码为 `preference`（那是用户偏好类目，且 90 天 TTL 对自省语义不对）。
`insight` 取 `general`（60 天 TTL）——自省由每日反思**持续重产**，短 TTL 不易堆积陈旧自我描述。

### 契约 2：【关于我】块**限量注入**（最近 8 条）

自省天然逐日累积。线上实测 31 条 = **1058 字 ≈ 705 tokens**，而 `PromptAssembler` 的 chat
预算是 **`new TokenBudget(3200)`**——该块占 22%。且它是 `assembleChat` 里**最后一个**做
`canFit` 检查的块（前面 persona / overlay / basics / prefs / 关于你的事实 都已 `reserve`），
超预算时**整块被丢弃**，她一条都读不到。

故 `PromptAssembler` **只注入最近 `CHARACTER_FACTS_IN_PROMPT = 8` 条**：
- 依据：自省表达的是「我此刻是谁」，近期的才代表当下的她
- 更早的**仍完整留在库里**（只是不进 prompt）
- ⚠️ **去重不是解药**：31 条的措辞差异超出 `normalizeKey`（剔字后取前 20 字）与
  `normContains`（长侧≥5 且短侧≥2）的判定范围，实测 `addCharacterFacts` **supersede 0 条**。
  `normalizeKey` 是为短标签型事实（「用户在长沙」）设计的，**对日记型长句基本无效**。
- **长期方案（未做）**：把陈旧自省**归并**成稳定的自我描述，而非逐条堆积。

### 契约 3：`source_event` 造的是**合成 id**，不可用于溯源

`recordReflection` 写入的 `source_event` 形如 `reflection-<YYYY-MM-DD>`，
**在 `events` 表里并不存在**（不是真实事件外键）。因此按 `source_event` 回溯 `events`
**必然失败**——这不是数据损坏，是设计如此。运维排查时应以 `evidence` 字段为准。

---

## 明确不涉及

- **不改 `LIFE_REFLECTION_PROMPT` 的语义** —— 它本来就是对的（关于她自己）
- **不新增"关于用户的洞察"字段** —— 那是扩大能力，不是修复
- **不修 `identity` 类目的用户事实重复**（25 条里「长沙」6 次等）—— 那是 `ProfileStore.addFacts`
  的去重算法问题，影响面与验证方式都不同，须独立 change

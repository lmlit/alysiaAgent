# Change Proposal: align-dsh-memory-blocks-with-scope

> ## ⚠️ 2026-10-24 方向变更：本 change 降级为「卫生修复」
>
> 用户决定：**dsh 的昔涟模式基本不用了，重心不放在这里，并先切断它对记忆系统的影响**
> （`bridge: false` → 停 ingest + 会话结算；见 PLAN「方向变更」一节）。
>
> 后果：`/api/memory/read` 不再被 dsh 调用 ⇒ 本 change 新增的两个字段**生产上不再被使用**，
> 世界书注入这条路**整体休眠**。
>
> **但本 change 不撤销**：它修的是一个**真实存在过的缺陷**（`triggers` 死参数 / 观测口径混淆），
> 代码与测试已全绿，恢复 dsh 通道即可直接生效。**撤销的事项**：
> - ❌ 决定 2（把 66 条 `scope='chat'` 设定迁移为 `both`）—— **取消**
> - ❌ 真机验收（`注入 N>0`）—— **不做**（且当前库里 `scope='code'` = 0 条，本来也做不到）
> - ⏸ F1–F11 里的语义/内容类修复 —— 挂起；**只做两条纯卫生项**：
>   F10（`blocks` 是 `MemoryReadRequest` 的死字段）、F8（`MemoryManager` 层数组顺序无断言）

## 元信息

- **日期**: 2026-10-24
- **类型**: MODIFY（改现有行为 + 改 Web API 契约）
- **状态**: **archived**（2026-10-24 归档。实现完成、全量 **157 文件 / 1863 用例**通过。
  ⚠️ 归档时已因 `cut-dsh-memory-bridge` 降级为**卫生修复**，见文首「方向变更」）
- **影响 spec**: `dsh-adapter`（§2.2 记忆 context，**已改**）、`memory-system`（§7 组装口，**已补一行 `assembleWithReport`**）
- **影响契约**: `docs/Web-API-Design.md` §2.4.4 `POST /api/memory/read`
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的 **P1**
- **排序决定**: 🧑 2026-10-24 用户拍板 **A：「P1 独立先做，不等 P8」**。
  理由：P1 是**正在漏的洞**（dsh 世界书一条都进不了 prompt），P8 是结构改善。
  **先堵洞，再搬家** —— 本 change 允许在现有 `assembleChat` 里直接加一段 if + 两个参数，
  等 P8 第 2 步（块注册表）时这段自然变成一条注册项。**认下"写两次"的代价。**

## 这条要解决什么

**dsh 会话里，世界书（worldbook）一次都没被读到过。** 而且是静默的——
日志还打着 `[memory/read] … worldbook 3 条`，看着像生效了。

### 证据链（四层，每层单看都对）

| # | 层 | 事实 | 位置 |
|---|---|---|---|
| 1 | 写侧 | dsh 回传 `source: 'code'`（**来源环境**语义，spec 明文规定） | `openspec/specs/dsh-adapter/spec.md` §2.5 |
| 2 | 写侧映射 | `const mode = event.source === 'code' ? 'code' : 'chat'` → 按 **code scope** 匹配世界书、记 trigger | `RealtimeProcessor.ts:51` |
| 3 | 读侧 | adapter 调 `/api/memory/read` **不传 `mode`** → server 默认 `'chat'` | `dsh-adapter/src/alysia-client.ts:166`、`webui/server.ts:1135` |
| 4 | 组装 | `assembleChat(retrieved, triggers, …)` 的 **`triggers` 是死参数**（函数体一次未引用）；只有 `assembleCode` 才 filter 并注入 `[情境提示]` | `PromptAssembler.ts:138,412` |

⇒ trigger 在写侧被算出来（还计入统计），在读侧匹配了另一批（chat scope），最后**被整包丢弃**。

### 而「改成工具」这条退路在 dsh 里也不成立

`PromptAssembler.ts:343` 放弃世界书的理由是「已改为 Agent 工具 `lookup_worldbook`」。
那个工具在**自家 ToolRegistry**（`core/src/tools/worldbook.ts:53`）；
`dsh-adapter` 只注册了 `recall_memory`（`index.ts:191`）与 `publish_page`（`index.ts:198`）。
⇒ dsh 里**两路皆断**。

### 根因：一个参数承担三种语义

`mode` 同时决定三件事，而 dsh 场景下三者想要**不同值**：

| 语义 | dsh 想要 | 理由 |
|---|---|---|
| 世界书 scope | `code` | 干活的对话，不该触发闲聊条目 |
| 提示块表（12 块 vs 6 块） | `chat` | 人味块（关于你/偏好/事实/关于我/待确认/最近对话/分寸）**只在 chat 表里** |
| token 预算（3200 vs 2450） | 更大 | 编程会话本来就长（**本 change 不处理预算**，见 §不做的事） |

一个参数表达不了三个需求 —— 选谁都错一半。现在选 chat：块表对了，scope 错了。

## 需求（做什么）

- [ ] `/api/memory/read` 增加两个可选字段：`blocks?: 'chat'|'code'`、`worldbookScope?: 'chat'|'code'`；
      `mode` **保留**并作为兜底（两者都缺省时按 `mode` 走旧语义，**向后兼容**）
- [ ] **`worldbookScope` 的语义 = 「显式给出 ⇒ 该 scope 的条目进 prompt；不给 ⇒ 只匹配、不注入」**，
      且**只对 `blocks='chat'` 生效**（`blocks='code'` 维持现状）—— 缺省路径与今天**逐字相同**
      （QQ / console 本来就是这个行为：匹配、计数、丢弃）。这样"dsh 自动注入 / QQ 走工具"的
      现状边界不会被顺手改掉
- [ ] `PromptAssembler.assembleChat` 支持注入 `[情境提示]` 块；**当且仅当**传入非空 triggers 时出现
      （不再静默丢弃）
- [ ] `dsh-adapter` 的 `readMemory()` 传 `blocks: 'chat'`、`worldbookScope: 'code'`
- [ ] 观测：`[memory/read]` 那行**区分"匹配到 N 条"与"实际注入 M 条"**（现在只有前者，会骗人）
- [ ] `assembleChat` 收到 triggers 却未注入时 → 打 `warnThrottled`（防下一次回归成静默）

## 设计决策

**选 A：拆参数。** 新增 `blocks`（块表）与 `worldbookScope`（世界书 scope）两个正交字段，
由调用方按场景组合；`mode` 退化为同时设置两者的糖，保证旧调用方（QQ / console / 自家 pipeline）行为不变。

**否决 B：给 chat 表无条件加回世界书块。**
理由：这会让 QQ 闲聊也把世界书塞进 prompt，推翻 2026-10 的「改工具以省 token」决定——
那是**产品决定**，不该被一个 dsh 的 bug 顺手推翻。

**否决 C：在 dsh 里注册 `lookup_worldbook` 工具。**
理由：与「世界书应该自动在场」的判断相反。dsh 是编程会话，**项目级世界书（技术约定等）
恰恰最该默认在 context 里**，而不是赌她想起来查一次。
（C 仍然可以**以后**做，作为 `blocks=chat` 场景的补充路径；本 change 不做。）

## 对账方向确认

- [x] **改 impl，不改 doc**。doc 侧（`Web-API-Design.md` §2.4.4「与聊天管线**同一套**组装」、
      spec §2.2「替代 MemoryRetrievalStage」）声明的是"一致"，impl 没做到（chat 表把 triggers 扔了）
      ⇒ 补实现，**不许把 doc 降级成"worldbook 不注入"来迁就现状**
- [x] **涉及 Web API** → 必须同步 `docs/Web-API-Design.md` §2.4.4 的请求形状（加两个可选字段 +
      默认值 + 兼容说明）

## 不做的事（本 change 范围外）

- **不改 token 预算**（3000/3200/2450 那一组）。预算不足导致的丢块**有日志**（`[Prompt] 预算不足…`），
  是已治理的显性问题；把参数拆开后才有条件单独评估 dsh 该给多少。**另开 change。**
- **不碰 P4**（`{{alysia_life}}` 恒空）。同一个"素材供应"模式，但它的正确形状还没定
  （见 PLAN §2.3 的待澄清项）。

## 测试计划

1. **单测（core）**：`assembleChat(retrieved, [wbEntry])` → 输出**包含** `[情境提示]` 与该条目内容；
   `assembleChat(retrieved, [])` → 不出现空标题（与现有 `PromptAssembler.test.ts:67` 那条对齐并加断言）
2. **单测（core）**：`worldbookScope='code'` 时只命中 `scope in ('code','both')` 条目；
   排除 `content_type === 'image'`（与 `assembleCode` 同款 filter）
3. **单测（server）**：`/api/memory/read` 四个组合（`blocks`×`worldbookScope` 有无）分别落到预期块表 +
   预期 scope；`mode` 单独给时行为与改动前**逐字相同**（向后兼容的 characterization）
4. **集成（dsh-adapter）**：`readMemory()` 发出的 body 含 `blocks: 'chat'`、`worldbookScope: 'code'`
5. **回归**：QQ / console 两条既有管线的 prompt 快照不变（`prompt-assembler-characterization`）

## 风险

- **世界书条目进 prompt 会吃预算**：`[情境提示]` 定为 **optional**（不进 required，
  避免 10-15 那类"整块挤掉别人"的事故），**插入位置：`[最近对话]` 之后、`[我的近期日常]` 之前**
  —— 与 `assembleCode` 的相对顺序对齐（情境提示 → life → 相关记忆）。
  ⚠️ **认下的代价**：`TokenBudget.reserve()` 对 required 块不校验、对 optional 块严格按剩余量
  （`pushBlock` 里 required 忽略返回值），所以 `[情境提示]` 一旦先占，**预算紧时被挤掉的是
  后面的 `[我的近期日常]` 与 `[相关记忆]`**。这条必须靠 `[Prompt] 预算不足…丢弃 …` 日志可查，
  不许再出现"静默少了一块"。
- **dsh 与 QQ 的世界书行为从此不同**（dsh 自动注入、QQ 仍走工具）——这是**有意的**，
  需在 spec §2.2 写清理由，否则下次对账会被当成不一致。

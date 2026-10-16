# Change Proposal: add-memory-channel-field

## 元信息

- **日期**: 2026-10-16
- **类型**: NEW（记忆元数据 + 迁移）
- **状态**: **archived**（2026-10-16 propose → apply → archive；未部署）
- **影响 spec**: `memory-system` §4.1.1 **契约 5**
- **来源**: 用户 2026-10-16 决定：「后续计划让昔涟可以走 dsh 调用 dsh 的编程工具」⇒
  QQ 日常对话与 dsh 编程会话在同一套库里并存，且**将来要特殊处理** ⇒ 必须能区分

## 为什么必须"写入时记"，不能事后反推

调研（`scripts/ki20/channel-fields.cjs`，实测）：

| 层 | 事发时能否区分 | 证据 |
|---|---|---|
| `events` | 只有前缀可靠 | `session_id LIKE 'dsh:%'` 730 条 |
| `conversations` | 只有前缀 | 5 条；表里**没有**渠道列 |
| `facts` | **不能** | `source` 取值是 `user`(221)/`inferred`(61) = **提取方式，不是渠道**；只能从 `source_event` 的 id 形态反推（带 `dsh-` 的 49/282 = 17.4%） |
| `adaptation_hints` | **完全不能** | 字段只有 `trigger/adjustment/evidence/applied_at` |

**两个坑（都实测过）**：

1. **`events.source` 不能当渠道用**：它是 `chat`/`code`（事件性质），而 dsh 会话里**两者都有**
   —— 730 条 dsh 事件里有 **28 条** `source='chat'`（用户消息）。用 `source='code'` 判 dsh **会漏 28 条**。
2. **前缀本身也是脆的**：dsh 拿不到 `session.id` 时退化成 `dsh:unknown`，
   多个真实会话挤一个桶（KI-23 就是这类）；而且 facts/hints 连前缀都没有。

⇒ 渠道必须是**显式字段**，写入时落库。

## 需求

- [x] **R1**：`utils/channel.ts` —— `channelOfSession()` 派生 + `isDshSubagentSession()`
- [x] **R2**：`events.channel` / `conversations.channel` 列（探测式幂等迁移，**不 DROP**）
- [x] **R3**：**写入时落库**（`EventStore.insert` / `ConversationStore.insert`），
      不写就得等下次启动回填 —— 那是"看起来对、其实靠重启兜底"的坏味道
- [x] **R4**：老库**回填**（只填 `channel = ''` 的行，不覆盖已判定的）
- [x] **R5**：判不出来记 **`'unknown'`**，**不许猜**；`''`（还没回填）与 `'unknown'`（判不出来）
      **语义不同，不许混**
- [x] **R6**：`facts` / `character_facts` 条目加 `channel`（写入点 `ProfileExtractor.toFact`，起源事件拿得到 ⇒ 如实派生）
- [x] **R7**：`adaptation_hints` 条目加 `channel`（**穿参**：`apply(adj, {channel})`，两个有事件上下文的调用方各传各的）
- [x] **R8**：枚举扩到 `life` / `system` —— 否则"生活事件驱动的调整"与"判不出来的老数据"都会落进 `unknown`，
      而两者处理策略完全不同（前者是设计行为，后者是数据债）
- [ ] **R9**：**老数据的回填**推迟到离线工具（见 tasks.md「为什么回填不放这儿」）

## 测试计划

`packages/core/tests/memory/channel-field.test.ts`（8 例，已过）：
派生四种前缀家族 + 判不出→unknown + 子会话判据 + 写入落库 + 显式值优先 + conversations +
回填 + 回填幂等（不覆盖已判定）。

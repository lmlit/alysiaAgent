# Spec delta: isolate-delegated-task-memory

> 目标 spec：`openspec/specs/dsh-adapter/spec.md`
> 本文件是**变更增量**。apply 时新增 §2.5.2（放在 §2.5.1 之后），
> 合并后运行 `scripts/check-spec-diff-residue.cjs`（残留 `^+` 即拒绝归档）。

---

## +§2.5.2 会话来源标记：机器发起的会话不是用户发言

> ★ 2026-10-17（change: `isolate-delegated-task-memory`）。
> 这是「机器自己的东西被当成用户的」这一族的**第三例**：
> 第一例是子 agent 会话（§2.5，`header.origin === 'subagent'`），
> 第二例是 dsh 的 runtime context 快照（§2.5，`source.kind === 'runtime-context'`），
> 本例外是**委托任务会话**（alysia 让 dsh 去干的工程活）。

### +2.5.2.1 契约：字段出现即「机器发起」

- 字段名 **`payload.dsh_origin`**（非空字符串）。
- **契约**：该字段**出现**（非空）即表示**这个会话是机器发起的，不是用户发言**；
  值同时作**跳过原因**留痕。服务端**不枚举已知值** —— 将来新增来源零改动。
- **契约**：缺省**不带这个字段**（**不是空串**）。带空串会被服务端当畸形输入拒收。
- **契约**：字段若出现必须是非空字符串，否则 `/api/ingest` **拒收**并给出具体原因。
- ⚠️ **与 `dsh_source` 正交，别混**：
  `dsh_source` 由 **dsh 给**，说的是「这条**消息**是什么」（`runtime-context` 等）；
  `dsh_origin` 由 **alysia 侧配**，说的是「这个**会话**是谁发起的」（`delegated-task` 等）。
  两者可以同时出现；同时命中时 `synthetic` 取**更精确的消息级原因**。

### +2.5.2.2 分工与落地位置（沿用 §2.5 的分工，不新增机制）

| 侧 | 职责 |
|---|---|
| adapter | **只上报事实**：`Config.sessionOrigin` 非空 ⇒ 每条回传带 `payload.dsh_origin` |
| 服务端 | **只做判定**：`normalizeIngestEvent` 打 `skip_profile = true` + `synthetic = <值>` |

**为什么两处配置（profile 级）而不是按 sessionId 登记**：
`sessionId` 只有在运行体启动后（`--json` 首行 / SDK 响应）才知道，而事件可能在那之前就发出
⇒ 头几条事件会**漏标记**，而漏掉的恰恰是最早的上下文；且登记需要「提交方」存在（阶段 C/D 才有）。
profile 级标记**零竞态、可独立验证、不依赖未来组件**。
将来提交方落地时可**另行**登记 sessionId 作为第二道闸。

### +2.5.2.3 为什么必须同时打 `skip_profile` 和 `synthetic`

一处标记，三处生效，但**消费方认的字段不同**：

| 消费方 | 认哪个 | 效果 |
|---|---|---|
| `RealtimeProcessor` | `skip_profile` | **早退**：不做人格扫描、不做纠正快路径、**不做嵌入** |
| `ProfileExtractor` | `skip_profile` | 不进画像 |
| `SessionEndProcessor` | **`synthetic`** | 不进摘要 |

⚠️ `SessionEndProcessor` **刻意只过滤 `synthetic` 不过滤 `skip_profile`**
（群聊 NPC 的 `skip_profile` 进摘要是既有行为）
⇒ **只打 `skip_profile` 会漏掉摘要这条路**，而摘要会被召回并回灌。

### +2.5.2.4 委托会话不结算

- **契约**：配了 `sessionOrigin` 的实例在 `session/disposed` 时**只排空、不调用**
  `/api/sessions/:id/extract`。
- 理由：结算的意义是把**对话**变成记忆；而该会话的事件已被明确排除在记忆之外
  ⇒ 结算只会白烧一次 LLM（摘要槽还贴着预算天花板，见 KI-1）并产出**空摘要行**。
- 事件**照常回传**（审计轨迹要留），跳过结算**必须留痕**。

### +2.5.2.5 留痕文案：原因中立

- `RealtimeProcessor` 的跳过日志为
  `跳过学习：非用户发言（<原因>）—— 不进画像/人格/嵌入`。
- ⚠️ 原措辞写死成「合成注入」，而 `synthetic` 现在也承载委托会话 —— 旧措辞会把排查带偏。
  **这是文案变更，不是行为变更**（限频与触发条件都不变）。

# Change Proposal: isolate-delegated-task-memory

## 元信息

- **日期**: 2026-10-17
- **类型**: NEW（新功能 / 新契约）
- **状态**: **archived**（2026-10-17 归档；T1–T5 完成、T6 真机验收通过、T7 待用户决定）
- **影响 spec**: `dsh-adapter`（§2.5.2 新增）、`memory-system`（学习闸的语义）
- **前置**：`openspec/archive/2026-10-17-connect-server-dsh-bridge/`（委托运行体已落地）
- **上游计划**：`docs/ALYSIA-DSH-BRIDGE-PLAN.md` §八 + D10
- **验收记录**：[`e2e-evidence.md`](e2e-evidence.md)

## 动机（为什么做）

委托任务在服务器上跑通后，**回传钩子确实在触发**（实测证据：`connect-server-dsh-bridge`
的 `e01-evidence.md` §5.4 里有 `session/event user|assistant` 两行）。而回传的事件
**没有打任何标记** —— 生产库实测：

```
dsh:session-58bfef87-…  n=2   dsh:session-8a8420f6-…  n=4   dsh:session-59e4a0eb-…  n=3
payload 标记分布：skip_profile=False synthetic=None dsh_source=None dsh_origin=None → 9 条
```

⇒ 若不处理，**Alysia 自己发起的工程任务会被当成「用户说了这些话」**：

| 后果 | 机制 |
|---|---|
| 画像回吸 | `ProfileExtractor` 只看 `skip_profile`；未标记 ⇒ 从任务书/代码里「学」出用户事实 |
| 人格放大 | `RealtimeProcessor` 未早退 ⇒ `PersonaAdapter.processSignal` 从工程文本触发 hints（记忆触发记忆） |
| 纠正误判 | 同处的「纠正快路径」会把任务书里的话当成用户纠正当场写画像 |
| 摘要污染 | `SessionEndProcessor` 只看 `synthetic`；未标记 ⇒ 进摘要、日后被召回 |
| 向量污染 | 未早退 ⇒ 该事件被嵌入并进召回道（同 9-27 清掉的那批垃圾向量同形） |

这与已修的**子 agent 污染**是**同一族的第三例**（第一例：子 agent 会话；
第二例：dsh 的 runtime context 快照）。前两例都是「机器自己的东西被当成用户的」。

## 需求（做什么）

- [x] dsh 侧：委托运行体的每条回传事件带一个**结构化的会话来源标记**（不是文本前缀）
- [x] 服务端：见到该标记 ⇒ 走**现有的「不学习」闸**（`skip_profile` + `synthetic`），
      **不新增机制**
- [x] 委托会话**不做结算**（`extractSession`）：它的内容按定义不进记忆，
      结算只会白烧一次 LLM 并造出空摘要行
- [x] 留痕可见：跳过必须能观测（否则「滤掉了」与「本来就没采到」长得一样）
- [x] 正常 dsh 会话（用户与她在编程模式里的对话）**行为一字不变**

## 设计决策（怎么做，含备选与取舍）

### 1. 标记放在 **profile 配置**里，不是「按 sessionId 登记」

`Config.sessionOrigin?: string`。非空 ⇒ 该实例回传的每条事件带 `payload.dsh_origin = <值>`。

**为什么不用「提交方按 sessionId 登记」**（看起来更自然，因为将来提交方就是 alysia 自己）：
- **有竞态**：`sessionId` 只有从 `--json` 首行或 SDK 响应里才知道，而事件可能在那一刻之前就发出了
  ⇒ 头几条事件**漏标记**，而漏掉的恰恰是最早的上下文；
- 现在**没有提交方**（阶段 C/D 才做），按登记做等于这一版**无法独立验证**。

⇒ 选 profile 级标记：**零竞态、可独立验证、不依赖未来组件**。
将来提交方落地时，仍可**另行**登记（那时它知道 sessionId，可以作为第二道闸）。

### 2. 服务端语义：**字段存在 = 该会话是机器发起的**

```
payload.dsh_origin 非空 ⇒ skip_profile = true, synthetic = <值>
```

- **不枚举已知值**：值只作**留痕原因**。新增来源（将来的「定时维护」等）零服务端改动。
- 缺失/为空 ⇒ 行为不变（当前唯一合法来源就是「用户与 dsh 的对话」）。
- ⚠️ 与 `dsh_source` 的分工：`dsh_source` 是 **dsh 给的、这条消息是什么**
  （`runtime-context` 等）；`dsh_origin` 是 **alysia 侧配的、这个会话是谁发起的**。两者正交。

### 3. 复用 `skip_profile`，不新增闸

实测确认它是**唯一**的「不学习」开关，且一处命中三处生效：

| 消费方 | 认哪个字段 | 效果 |
|---|---|---|
| `RealtimeProcessor` | `skip_profile` | **早退**：不匹配后继续 → 不做人格扫描、不做纠正快路径、**不做嵌入** |
| `ProfileExtractor` | `skip_profile` | 不进画像 |
| `SessionEndProcessor` | `synthetic` | 不进摘要 |

⚠️ 注意 `SessionEndProcessor` **刻意只过滤 `synthetic` 不过滤 `skip_profile`**
（群聊 NPC 的 `skip_profile` 进摘要是既有行为）⇒ **必须同时打 `synthetic`**，
只打 `skip_profile` 会漏掉摘要这一条路。

### 4. 跳过时的留痕措辞要泛化

`RealtimeProcessor` 现有的限频日志写死成
`跳过学习：合成注入（<reason>）—— 不算用户发言，不进画像/人格/嵌入`。
委托会话不是「合成注入」，措辞会误导排查。改为**原因中立**：
`跳过学习：非用户发言（<reason>）—— 不进画像/人格/嵌入`（纯文案，行为不变）。

### 5. 委托会话**不结算**

`extractSession` 存在的意义是把**对话**变成记忆；而委托会话的事件已被明确排除在记忆之外
⇒ 结算只会白烧一次 LLM（摘要槽还贴着预算天花板，见 KI-1）并产出空摘要行。
故 `sessionOrigin` 非空时**跳过结算**，并打一行日志（跳过必须可见）。

### 6. 本次**不做**

- 数据修复：生产库里那 9 条**已存在的**未标记探测事件（含其向量）——
  另开 change（同 KI-20 的做法：先备份、`VACUUM INTO`、只删不猜）；
- 任务表 / 提交工具 / 结果回送（阶段 C/D）——那时「类型化的项目结果」才存在；
- 桌面端那份 adapter 的行为（它不设 `sessionOrigin`，逐字不变）。

## 对账方向确认

- [x] 与现有 spec 冲突？→ **不冲突**：`dsh-adapter` §2.5 已确立「adapter 只上报事实、
      服务端只做判定」，本 change 是**同一分工的第三个来源**；
      `memory-system` 的 `skip_profile` 语义不变（只是多一个触发来源）
- [x] 涉及 Web API？→ **不新增接口**（复用 `/api/ingest`），
      故 `docs/Web-API-Design.md` **不需要改**

## 测试计划

| 层 | 内容 |
|---|---|
| adapter 单测 | 配了 `sessionOrigin` ⇒ payload 带 `dsh_origin`；没配 ⇒ **不带该字段**（不是空串）；配了 ⇒ 不调用 `extractSession` |
| server 单测 | `dsh_origin` ⇒ `skip_profile` + `synthetic`；**不带 ⇒ 一字不变**；空串/非字符串 ⇒ 拒收；与 `dsh_source` 正交（两个都带时都要生效） |
| core 单测 | `skip_profile` 事件仍早退（既有行为不变）；留痕文案泛化后仍限频 |
| 回归 | 全仓 **112 文件 / 1296 用例**，exit 0 |
| 真机 | ✅ 已做：部署后跑两轮委托任务，生产库 6 条事件逐条带标记、0 条摘要行、历史事件未误伤（见 `e2e-evidence.md`） |

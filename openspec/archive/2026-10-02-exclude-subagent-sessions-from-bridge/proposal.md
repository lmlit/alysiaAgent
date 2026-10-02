# Change Proposal: exclude-subagent-sessions-from-bridge

## 元信息

- **日期**: 2026-10-02
- **类型**: FIX（修 bug）+ MODIFY（spec 修正错误声明）
- **状态**: archived（2026-10-02 完成并归档；apply 已合并回 `openspec/specs/dsh-adapter/spec.md`）
- **影响 spec**: `dsh-adapter`（§2.5 消息 ingest hook、§5 对接约束）
- **上游**: `connect-dsh-alysia-bridge`、`bridge-memory-read`、`record-dsh-as-coding-mode`

## 动机（为什么做）

**用户报告**：「用 dsh 跑了一段时间，发现一个问题，就是子 agent 执行的东西也会提取人格，会有问题。」

### 根因：spec 里一句被实证推翻的平台事实

`dsh-adapter` spec §2.5 写着「插件在 preset 内挂载 → scoped 监听天然只收本 agent 事件」。
**这句是错的**。本次从 dsh 源码逐条核过：

- preset 是**一个 standing mount 被所有 agent 共享**：父 agent 与子 agent 的 scope key
  都直接绑到同一个 standing key
  （`deepseek-harness-master/packages/preset/agent-presets/src/index.ts:275-288`、`:316-325`）
- scope 事件**向上冒泡**：注册在祖先 scope 的监听器**会收到所有后代 scope 的事件**
  （`packages/core/scope/src/index.ts:170-185`，注释原文 "a listener owned by an enclosing scope
  receives every descendant scope's events … events flow up the chain, never down"）

于是 `packages/dsh-adapter/src/index.ts` 的两个钩子（`:196` `session/event`、`:244` `session/disposed`）
**会收到全部子 agent 会话的事件**，而插件只按 session id 区分、没有任何父子概念——
子会话的 id 是一个插件从未见过的裸 `randomUUID()`，被当作一条新会话正常回传并结算。

### 实证（2026-10-02，本机库与 dsh 会话目录只读盘点）

11 个子 agent 会话、**127 条事件**已入库；`conversations` 里 12 条**人格化摘要**：

> 「昔涟做起这份审计像在拆案，读到『三个文件一处 try/catch 都没有』时反而来了兴致……」

——一次纯代码审计被写成了她的人格化情绪体验。连带污染：

| 污染面 | 数量 | 样例 |
|---|---|---|
| persona `adaptation_hints` | 34 条（10-02） | 工程约束「只观测不拦截」被当性格反馈 |
| user facts（`source_event: dsh-*`） | 48 条 | 「用户本次要求昔涟在 6 个 store 文件里……」 |
| `character_facts` | 18 条（10-02 全部） | 工程约束被写成人格特质 |
| `conversations` 摘要 | 12 条 | 见上 |

★ 还有**回流闭环**：注入子 agent prompt 的人设上下文（「生活在长沙、从事技术工作」）
被当成**新的**用户事实重新抽取、`valid_from` 被刷新。

### 判据（dsh 已提供持久化字段）

`SessionHeader`：`origin?: 'subagent'` / `parentSession?` / `delegationDepth?`
（`packages/core/session/src/types.ts:75-91`；`Session.header` 是公开 readonly 属性，
`packages/core/session/src/index.ts:443`）。**用 `origin === 'subagent'`**；
`parentSession` 不能单独用——`SessionStore.fork()` 也会设它、但不设 `origin`。

## 需求（做什么）

- [ ] `installBridge` 两个钩子开头按 `origin === 'subagent'` 早退（不回传、不结算）
- [ ] 跳过**可观测**：每个子 agent 会话首次出现打一行 `info`，不静默丢弃
- [ ] 单测：子会话不 ingest / 不 extract；主会话行为逐位不变（现有断言全绿）
- [ ] spec：替换 §2.5 的错误声明 + §5 追加子会话判据约束

## 设计决策

**决策 1：落点在插件（adapter），不在 server/core**

server 区分不了——`/api/ingest` 只看得到 `dsh:` 前缀（主/子会话前缀相同）；
`origin` 只有插件进程拿得到（在 session 对象上）。

**决策 2：子 agent 会话「完全不回传」——ingest 与结算都跳过**（用户拍板）

子 agent 是主 agent 派出的执行单元，其内容（任务书 / 工具过程 / 审计报告）不是「她与用户的对话」；
产出由**主会话摘要**覆盖（主会话摘要本就写着「派了 N 路 subagent」）。
否决「回传但打标、只排除人格/画像」：要改 core 的 `RealtimeProcessor`/`SessionEndProcessor`，
改动面大得多，且子 agent 内部过程对召回也没有独立价值。

**决策 3：不新增配置开关**（YAGNI；以后想放进来再开 change）

**决策 4：主会话（code 模式）保留现状——继续参与人格/记忆**（用户确认）

「编程也是相处，她的性格该被这段经历影响」是 `record-dsh-as-coding-mode` 的既有设计
（该 proposal 决策 2 原文）。本 change 只堵子 agent 这个缺口。

## 对账方向确认

- [x] §2.5 那句是**平台事实写错了**（非 impl 落后）→ 改 doc；
      而「子 agent 会话必须排除」这条**契约 impl 没接** → 改 impl。两者方向不同，不混淆。
- [ ] 涉及 Web API？**不涉及**——纯插件侧过滤，server 端点与契约零改动。

## 测试计划

- `packages/dsh-adapter/tests/index.test.ts` 补：
  - 子会话 `session/event`（含 user/message）不入队 → 无 ingest
  - 子会话 `session/disposed` → 既不 ingest 也不 extract
  - 子会话首见打一行 `info`（可观测）；主会话既有断言逐位不变
- 包内：`pnpm --filter @alysia/dsh-adapter test`
- 全仓回归：`PATH="/e/nodejs24:$PATH" npx vitest run`（基线 965）

## 顺带发现（登记 KI，不在本 change 修）

1. `/api/sessions/:id/extract` **无任何校验**——`/api/ingest` 只收 `dsh:` 前缀，extract 端点谁都能调
2. 同一会话被**重复摘要**（`dsh:9a33c81f` 09:29:56 与 09:30:14 各一次；`dsh:session-02e15a3c` 同）

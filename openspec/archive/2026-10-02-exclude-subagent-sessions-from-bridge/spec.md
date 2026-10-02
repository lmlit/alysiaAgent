# Spec 变更: exclude-subagent-sessions-from-bridge

> **apply 说明**：本 change 改 `dsh-adapter` spec 两处——
> **变更 1** 是**整行替换**（§2.5 的一条错误声明），**变更 2** 是**追加**（§5 末尾加一条约束）。
> ⚠️ **不使用 `+`/`-` diff 标记**——沿用 `2026-10-02-observe-zero-row-writes` 的先例，
> 理由见 backlog `clean-spec-diff-residue`：`+ ` 标记混进正文后，会带偏一切基于 `grep '^+ '` 的校验，
> 且本项目已两次因此被误导。替换/追加的边界以下文的分节标题为准。

---

## 变更 1：§2.5 —— 替换「scoped 监听天然只收本 agent 事件」那一行

**删除原句**（现 `openspec/specs/dsh-adapter/spec.md` §2.5 第一行）：

```
- 插件在 preset 内挂载 → scoped 监听天然只收本 agent 事件
```

**替换为**（缩进与同级 bullet 一致，紧接在 §2.5 表格之后、「✅ 2026-10-01 通道已落地」一条之前）：

```
- **★ 子 agent 会话必须显式过滤**（2026-10-02，change: `exclude-subagent-sessions-from-bridge`）：
  preset 是**一个 standing mount 被所有 agent 共享**——父 agent 与子 agent 的 scope key
  都直接绑到同一个 standing key（dsh `packages/preset/agent-presets/src/index.ts:275-288`、`:316-325`），
  而 scope 事件**向上冒泡**：注册在祖先 scope 的监听器**会收到所有后代 scope 的事件**
  （`packages/core/scope/src/index.ts:170-185`）。
  ⚠️ 本节原句「插件在 preset 内挂载 → scoped 监听天然只收本 agent 事件」**已被实证推翻**
  （2026-10-02：11 个子 agent 会话、127 条事件进了库，污染了人格摘要/adaptation_hints/user facts）。
  **契约**：`session.header.origin === 'subagent'` 的会话**一律不回传、不结算**——
  子 agent 是主 agent 派出的执行单元，其内容（任务书 / 工具过程 / 审计报告）不是「她与用户的对话」；
  产出由**主会话摘要**覆盖（主会话摘要本就写着「派了 N 路 subagent」）。
  跳过**必须可观测**（每个子会话首次出现打一行 `info`），不许静默丢弃。
```

---

## 变更 2：§5 —— 追加一条对接约束（接在 §5 末尾）

```
- **子 agent 会话判据**：`session.header.origin === 'subagent'`
  （`SessionHeader` 的持久化字段，resume 也在；dsh `packages/core/session/src/types.ts:85`；
  `Session.header` 是公开 readonly 属性，`packages/core/session/src/index.ts:443`）。
  **不可用 `parentSession` 单独判**——`SessionStore.fork()` 也会设它、但不设 `origin`。
  **不可用 id 形状判**——主会话恰好是 `session-<uuid>`、子会话恰好是裸 `uuid`，
  那是当前命名巧合，不是契约。**不可用 scope 判**——父子共享同一 standing key。
```

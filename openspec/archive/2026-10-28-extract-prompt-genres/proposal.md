# Change Proposal: extract-prompt-genres

## 元信息

- **日期**: 2026-10-28
- **类型**: REFACTOR（P8 第 4 步）
- **状态**: applied（纯声明重构，prompt 输出逐字不变；未单独发版，随下一批行为变更上线）
- **来源**: `docs/PLAN-2026-10-24-context-and-rules.md` §2.6；P8 前三步已归档

## 问题

8 条生成链路的**预算 / 采样 / persona 节数 / forbids** 仍散在各函数体里：

- `PromptAssembler` 里裸的 `new TokenBudget(3200)` / `new TokenBudget(2450)`；
- `llm-agent` 里 `getCompactPersonaPrompt()` 默认 4 节；
- `proactive` 里 `DEFAULT_SAMPLING.proactive.personalize` + 内联体裁约束；
- summary / profile / life 各写各的采样槽，新加一条链路只能再抄一份。

PLAN 的判据：**体裁别做成布尔**（4 个布尔 = 16 种组合，12 种非法），
用 genre 枚举 + `forbids` 白名单，让非法组合根本表达不出来。

## 需求

- [ ] 新增 `memory/genres.ts`：8 个体裁的声明表（预算/采样/persona/forbids）。
- [ ] `PromptAssembler` 的 chat/code 预算改读表。
- [ ] `llm-agent` 的 chat persona 节数改读表。
- [ ] `proactive` 的采样改读表。
- [ ] 单测：8 个 id、预算、forbids 合法块 key、采样槽指向正确。
- [ ] 行为不变：characterization 快照逐字相同；全量测试绿。

## 明确不做

- 不重写 17 条链路的 prompt 文本。
- 不把 genres 做成运行时开关（它是**声明表**，不是 feature flag）。
- 不动 life 的 7 条子链路（它们共享 `life-daily` 采样槽，后续再收）。

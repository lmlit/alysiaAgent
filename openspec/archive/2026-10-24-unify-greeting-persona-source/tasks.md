# Tasks: unify-greeting-persona-source

> 人格来源收敛（P10）。doc 早已声明「以昔涟身份」，impl 用的是写死的一句 —— **改 impl**。

## 实现任务

- [x] 新增 `packages/server/src/prompts/proactive.ts`：
      `GreetingPersona` / `PROACTIVE_PERSONALIZE_TASK` / `buildProactiveSystemPrompt()`
- [x] 身份与语气从 `getPersonaSnapshot()` 取（名字 + 4 个语气维度 + 2 个风格维度 + 2 个情感维度）
- [x] 删掉写死句「你是昔涟，一个温柔贴心的 AI 伴侣」
- [x] `modules/proactive.ts` 的 `generateText` 改用 builder
- [x] `prompts/README.md` 登记（顺手把 `life.ts` 的「5 段」更正为「8 段」—— 早就不是 5 段了）
- [x] spec `proactive-messages` §2.2 补记这次收敛的理由、历史与两条禁令

## 测试任务

- [x] `packages/server/tests/proactive-prompt.test.ts`（5 例）—— 含**反向断言**：
      「温柔贴心」「AI 伴侣」不许再出现（否则这个洞会悄无声息长回来）
- [x] 回归 `proactive.test.ts`(32) 全绿
- [x] 全量 159 文件 / 1887 用例（Node 24）

## Apply 任务

- [x] 合并 spec 改动（`proactive-messages` §2.2）
- [x] 运行 `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`（proactive-messages 行「最后变更」）
- [x] `docs/PROMPT-INVENTORY.md` §2 路径 13（主动问候）→ 人设来源改标 DB
- [x] `docs/PLAN-2026-10-24` 的 **P10** 改状态
- [x] `docs/TODO.md` 对应行
- [x] 归档到 `openspec/archive/2026-10-24-unify-greeting-persona-source/`

## 明确不做

- ❌ 不注入完整 compact persona（实测 6375 字，对 30-60 字的输出不划算）
- ❌ 不注入 `worldview` 节（与"要短"的体裁约束打架，另议）
- ❌ 不改 `proactive.personalize` 的采样槽（温度问题归 P8 第 4 步 `genres`）

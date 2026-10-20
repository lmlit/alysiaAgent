# Tasks: label-dual-persona-sources

- [x] `packages/dsh-adapter/src/persona.ts` 顶部：源/浓缩/同步时机 三件事写清
- [x] `packages/core/src/persona/soul.md` 顶部：对称提示（双向可发现）
- [x] 守卫测试 `packages/dsh-adapter/tests/persona-sync.test.ts`（4 条）
      - 锚句 ①身份 ②内在性 ③连续性 两份都在
      - 浓缩版长度 < 原文 1/3（防"把全文贴进来"）
- [x] 全量：**143 文件 / 1771 测试全绿**
- [x] 归档 + 索引 + TODO + HANDOFF

## 说明

- 用户 2026-10-20 拍板「维持两份，但标清楚各自的来源」——**不合并**。
- 理由：dsh 的 persona 是 preset `prefix`，每轮全量发出；塞全文等于每轮白烧 token。
- 锚句判据按**概念**（归一化标点/空白），否则一句标点改动就会误报、测试最后会被删掉。

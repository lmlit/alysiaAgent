# Tasks: organize-prompt-layer

## A1 提示词外置（4 处 → `packages/core/src/prompts/memory.ts`）

- [x] `SESSION_SUMMARY_SYSTEM_PROMPT`（会话摘要）
- [x] `PROFILE_EXTRACT_SYSTEM_PROMPT`（画像提取）
- [x] `buildCorrectionPrompt(activeFacts)`（纠错判断，带插值故为函数）
- [x] `CRON_DEEP_PROFILE_SYSTEM_PROMPT`（深度画像，**纯文本**槽）
- [x] 三处调用点改为 import（`SessionEndProcessor` / `ProfileExtractor` ×2 / `CronProcessor`）
- [x] 删掉 `SUMMARY_SYSTEM_PROMPT` 同义常量（避免两份名字）
- [x] **逐字校验**：`git show HEAD` 原文 vs 新常量，字面量内容比对 —— 4/4 相同
- [x] 文件头写清「本文件是逐字搬移」+ 与 sampling 槽的对应表（防 deepRewrite 误用 extract 槽）

## A2 块策略表（`PromptAssembler`）

- [x] `CHAT_BLOCK_POLICY`（11 块：selfNotice/persona = required，其余 optional）
- [x] `CODE_BLOCK_POLICY`（6 块：persona = required）
- [x] `pushBlock()` + `pushChatBlock()` / `pushCodeBlock()` helper
- [x] 17 处 `if (budget.canFit(x)) { reserve; push }` 收敛成 helper 调用
- [x] 预算不足时留痕：`[Prompt] 预算不足，本轮丢弃 N 块：…`（chat / code 各一行）
- [x] **characterization 快照**（4 场景：chat/empty、chat/rich、chat/starved、code/rich）
- [x] 重构后快照**逐字未变**、未使用 `-u`

## 验证

- [x] `tsc` core 通过
- [x] 定向测试：characterization 4 + `PromptAssembler.test.ts` 7 + `prompt-assembler-life.test.ts` 11 = 22 全绿
- [x] 全量（Node 24，免 API）：**139 文件 / 1743 测试全绿**

## 收尾

- [x] `memory-system` §4.1.5 新增契约
- [x] 归档 + 更新索引 + HANDOFF
- [ ] A3（统一客户端观测字段）/ A4（scripts 里的 prompt 副本改 import）—— 下一轮

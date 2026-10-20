# Tasks: put-dropped-turns-back

- [x] `AgentContext.truncate()` **返回**被丢弃的轮次
- [x] `AgentContext`：`addDropped` / `takeDroppedBuffer` / `droppedBufferChars` / `droppedBufferLength`
- [x] `AgentContext.setContextSummary()`：插在 system 之后 + **替换**同一条（累积语义）
- [x] `AgentHooks.summarizeDroppedTurns?`（可选 hook，未实现 = 旧行为）
- [x] `AgentRunner.compressDroppedTurns()`：攒批阈值 4 条 / 1200 字；失败与空返回都 warn 限频
- [x] `prompts/context.ts`：压缩 / 合并两套系统提示（只留事实、不许编造、≤400 字）
- [x] `MemoryManager.summarizeContextSlice()`（纯数据进出，走 `profile.deepRewrite` 纯文本槽）
- [x] `llm-agent` 注入实现（core 不持有 LLM）
- [x] `docs/Web-API-Design.md` §2.6 登记新 core 方法
- [x] 测试 `context-backfill.test.ts`（8 条）
- [x] 全量：**145 文件 / 1789 测试全绿**
- [x] `alysia-architecture` §6.5（8 条契约 + **可证伪判据**）
- [x] 归档 + 索引 + HANDOFF

## 待真实环境验证（**不是"已完成"**）

按 §6.5.2 的判据验：长会话（>3 次压缩）中途埋三件事 → 继续很久后追问 →
**至少 2 件答对**才算有效；只答得出最近那件 ⇒ 退回（删掉 hook 实现）。

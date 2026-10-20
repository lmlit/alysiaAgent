# Tasks: make-her-brief

- [x] `prompts/chat.ts`：`CHAT_BREVITY_DIRECTIVE`（默认 ≤3 句 / 两个例外 / 禁止铺垫复述总结追问）
- [x] `PromptAssembler`：`ChatBlockKey` 加 `brevity`，策略 **required**，注入点**排在最后**
- [x] `dsh-adapter/src/persona.ts`：浓缩人格加同一约束（编程模式也短）
- [x] `persona/talk_system.md`：同步（给新导入的角色包；并注明"硬编码在 chat.ts"）
- [x] 测试：`tsc` core + adapter 通过
- [x] characterization 快照 3 个**已更新**（行为变更，diff 只多 `【说话的分寸】` 一块）
- [x] 全量：**146 文件 / 1794 测试全绿**
- [x] `memory-system` §4.1.7（5 条契约）
- [x] 归档 + 索引 + HANDOFF

## 验收（真实环境，未做）

- 普通闲聊：**≤3 句**
- 问步骤/要求展开：可以长，但先给结论
- 不再出现"总结一下""还有什么想聊的吗"
- dsh 编程模式同样变短（走 persona.ts 那条）

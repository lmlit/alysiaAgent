# Change Proposal: make-her-brief

## 元信息

- **日期**: 2026-10-20
- **类型**: BEHAVIOR（提示词内容变更，**两条链路**）
- **状态**: `applied`
- **影响 spec**: `memory-system` **§4.1.7（新增）**

## 问题

她的回复太长。而 `persona/talk_system.md` 里**本来就有**长度规则（问候 1-3 句 / 日常 3-6 句）。

两处让它失效：

1. 那段 md 只在 **seed 角色包**时拼进 `persona.system_prompt` —— **改 md 不重导不生效**，
   而重导有覆盖用户自定义人设的风险
2. **dsh 编程模式完全不读它**（用 `persona.ts` 的 380 字浓缩人格）

## 判断

长度是**产品级约束**（我们决定她别啰嗦），不是角色设定（那是用户的）。
所以放代码：`prompts/chat.ts` → `CHAT_BREVITY_DIRECTIVE`，改动即生效、不受库里旧人设影响。

## 需求

1. 新增常量（默认 ≤3 句；两个例外；禁止铺垫/复述/结尾总结/追问）
2. `PromptAssembler` 作为 **`required` 块、排最后**注入
   （required：丢它 = 她话痨；最后：输出约束靠生成位置更有效）
3. `dsh-adapter/src/persona.ts` 浓缩人格加同一约束
4. `persona/talk_system.md` 同步（给新导入的角色包）
5. spec §4.1.7 五条契约

## 为什么写成「默认值 + 例外」而不是「参考」

旧写法"回复长度与用户输入成正比"是软约束，模型基本无视。
新写法给**默认值**（3 句）+ **白名单例外**（问步骤 / 要求展开）+ **点名最常见的借口**
（"为了把话说完整"）。软约束改硬约束，这是本次真正的改动。

## 不做什么

- 不改 `speech_style.sentence_length` 参数（那是人格滑杆，不是硬约束）
- 不设 `max_tokens`（会截断句子，比啰嗦更糟）
- 不动 QQ 的分段发送逻辑

## ★ 快照为什么变了

`prompt-assembler-characterization` 的 3 个快照**失败 → 已更新**。
这是**行为变更**，快照**应当**变；diff 只多了 `【说话的分寸】` 一块。
⚠️ 不许在非行为变更时更新快照（否则底片退化成装饰）。

## 回滚

删掉 `PromptAssembler` 里 `pushChatBlock('brevity', …)` 一行 + persona.ts 那段。
md 可留（无害）。

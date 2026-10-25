# Change Proposal: make-speech-rules-reachable

## 元信息

- **日期**: 2026-10-25
- **类型**: FIX（**规则不可达** —— 上一轮改了但从未生效）
- **状态**: applied
- **影响 spec**: `memory-system`（§4.1.7 契约 6 更正 + 新增契约 9「人格注入面」）
- **发现方式**: 用户让我「看看日志验证一下」→ 查库发现 8 小时 0 条用户消息 → 顺手核对
  `compact persona` 到底含哪几节 → **发现规则根本不在 prompt 里**

## 动机：我上一轮的"验证"验错了层

2026-10-24 我把四段说话规则写进 `persona/talk_system.md`，然后"验证"了：

```
persona.system_prompt = 38248 字
开口先有反应 = YES  语气词是调味料 = YES  说话样本 = YES …
→ "已部署并验证"
```

**但那只是 DB 里那一列有这些字。** 真正的问题是：

| 事实 | 值 |
|---|---|
| `system_prompt` 按 `\n---\n` 切出的节数 | **42 节** |
| 聊天实际注入（`getCompactPersonaPrompt()`） | **前 4 节** = soul + identity + worldview ≈ **6697 字** |
| `talk_system.md` 的位置 | **第 8 节起**（`system.md` 第 7 节起） |
| ⇒ 上一轮四段规则 | **一个字都没进过聊天 prompt** |

也就是说：**往 `talk_system.md` 写聊天规则，无论重导多少次，都是写给不读它的人看的。**

## 需求（做什么）

- [x] 把"说话的手感"并进 **`prompts/chat.ts` 的 `CHAT_BREVITY_DIRECTIVE`**
      （`required` 块、改动即生效、不受库里旧人设影响 —— 与长度约束同一处理手法）
      内容压紧到 ≈350 字：开口先有反应 / 具体化 / 素材来源【我的近期日常】·【此刻的你】/
      没有素材不许编 / **配额（语气词·♪·反问 合计最多一处）** / 允许不完整
- [x] `talk_system.md` 顶部加**自报声明**：🚫 本文件不进聊天 prompt，附节数证据与真正的生效位置
- [x] spec 契约 9 记录"人格注入面"（前 4 节 = 哪些文件生效），并更正上一轮的结论

## 设计决策

**为什么不改 `getCompactPersonaPrompt()` 的 4 节上限**：那会把 `system.md`(2115 字) +
`talk_system.md`(≈1300 字) 一起塞进每轮 prompt，**每轮多烧约 2.3k 字符**，而且 `system.md`
与 `soul.md` 大量重叠。长度与说话方式属于**产品级约束**（本仓已有先例：`make-her-brief`
把长度规则搬进代码正是为了绕开这个可达性问题）。**放代码 = 可达 + 改动即生效 + 不受旧人设影响。**

**为什么 md 还要留着**：它是"聊天该长什么样"的设计说明，也是**新导入角色包**的素材来源。
留着但**自报不进 prompt**，避免下一个人重复我这个错误。

**为什么快照更新是合法的**：这是**有意的行为变更**（prompt 文本确实变了）。
已核对快照 diff：**只多了 `【说话的手感】` 12 行 ×3 个场景，丢弃集合未变**
（`chat/starved` 仍丢同一块）—— 也就是说 required 块变长没有把 optional 块挤掉。

## 对账方向确认

- [x] **改 impl**（spec 早就声明"长度是产品级约束、放代码"，说话方式同属产品级）
- [x] 涉及 Web API？**否**（`/api/memory/read` 返回的 context 会自动带上新块）

## 测试计划

新增 `tests/memory/unit/speech-rules-reachable.test.ts`（6 例）——守**可达性**而非文案：

- 四件"人手感"必须在 `CHAT_BREVITY_DIRECTIVE` 里（配额、素材来源、不许编都在）
- 长度约束没被挤掉（首句仍是「说话的分寸 / ≤3 句」）
- 块长度 < 900 字（它是 `required`，越长越挤 optional）
- ★ `talk_system.md` 开头**必须自报**"不进聊天 prompt"且点名 `prompts/chat.ts`
- ★ `getCompactPersonaPrompt(sections = 4)` 的默认值被源码断言钉住（数字变 = 注入面变）

全量：**165 文件 / 1935 用例**。

## 风险

- ⚠️ 块变长 ≈350 字（required，无条件占预算）⇒ 极端预算下可选块更容易被丢。
  实测 `chat/starved` 丢弃集合未变；若线上出现丢弃日志增多，应缩块而非加预算。
- ⚠️ `♪` 出现在指令里是**有意的**（要告诉她"这是调味料"），不是笔误。

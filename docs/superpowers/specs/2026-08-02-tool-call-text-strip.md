# Tool 调用残留文本剥离（Tool-Call Text Strip）

> 日期：2026-08-02 · 状态：✅ 已实现 · 类型：Bug 修复 / 加固

## 背景与现象

QQ 私聊实测（2026-08-02 07:39 日志）：用户问"长沙阳光地铁站附近适合散步的地方"，机器人回复原文包含：

```
好的，我来帮你查一下长沙阳光地铁站附近适合散步的地方～
<tool_calls>
<invoke name="web_search"> ... </invoke>
</tool_calls>
```

工具调用 XML 被当作普通文案直接发给了用户。

## 根因

- 前几轮（07:39:46–07:39:54）模型正常返回**结构化** `message.tool_calls`，provider 识别并执行搜索 ✅
- 最终回复轮（07:39:58）模型**没有走结构化 tool_calls 通道**，而是把工具调用以**纯文本（伪 XML）**写进 `content` 字段 —— deepseek-v4-flash 在连续多轮工具调用后的已知不稳定行为
- 代码两层都无兜底：provider 只检查 `message?.tool_calls` 是否为空（`openai.ts`），为空即视为普通回复；runner 直接 `finalText = completionText` → RespondStage 原文发送

## 修复方案（双层防护）

### 1. 兜底剥离（主防线）— `core/src/utils/tool-call-strip.ts`

纯函数 `stripToolCallText(text)`，对 **LLM 回复文本** 剥离所有工具调用残留标记：

| 模式 | 示例 | 处理 |
|------|------|------|
| tool_calls 完整块 | `<tool_calls>...</tool_calls>` | 整块删除 |
| invoke 对（含 antml 变体） | `<invoke name="x">...</invoke>` / `<antml:invoke ...>` | 整块删除 |
| 自闭合 | `<invoke name="x" .../>` | 删除 |
| 未闭合容器（截断场景） | `<tool_calls>...` 到末尾 | 删到文本末尾 |
| 孤立闭包标签 | `</tool_calls>` `</invoke>` | 删除 |
| 剥离后残留 | 连续空行 / 连续空格 / 首尾空白 | 清理 |

接入点：`agent/runner.ts` plain-text 分支（唯一收口，覆盖所有 provider）。剥离发生且内容有变化时 `logger.warn` 记录（诊断可见）。

### 2. 提示词约束（次防线）— `pipeline/stages/llm-agent.ts`

system prompt 追加工具调用纪律：

> 需要实时信息时通过系统提供的工具调用机制发起。严禁在回复文本中书写任何工具调用 XML 标签（tool_calls / invoke），出现在回复文本里的此类标签将被系统剥离。

## 边界与约定

- **只应用于 LLM 回复**，不应用于用户消息（用户可能正常聊到这些标签文本）
- 不处理 `<thinking>`/`<reasoning>` 等非工具调用标签（不扩大范围）
- 流式路径（`textChatStream`）尚未接入主链路，本次未做分片级剥离；接入时需注意 chunk 边界截断问题
- 保留 provider 层原始 content 日志（剥离前），便于诊断模型行为

## 验证

- 新增 `core/tests/utils/tool-call-strip.test.ts`：9 个用例（正常文本 / 完整块 / 孤立 invoke / antml 变体 / 自闭合 / 截断 / 残留标签 / 空白清理 / 零开销路径）✅
- `tests/agent` 19 个测试全部通过，core 全量 210/212（2 个失败为需真实 API key 的 e2e，与本次改动无关）

## 已知限制 / 待办

- 剥离是"防泄漏"而非"补执行"：被剥离的工具调用不会执行。若模型频繁以文本形式输出工具调用，可升级为"检测到残留 → 重试该轮"策略
- stream 模式接入时需处理分片边界（标签可能被截断在 chunk 中间）

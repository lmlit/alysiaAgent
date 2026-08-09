# Change Proposal: life-event-json-response-format

## 元信息

- **日期**: 2026-08-09
- **类型**: MODIFY（治本修复）
- **状态**: applied（用户提议 + 已实现）
- **影响 spec**: ai-life-system（§6 事件生成）+ provider 契约

## 动机（为什么做）

8-09 裸文本问题（07:16 事件生成输出非 JSON 被丢弃）已有应用层容错
（life-bare-text-event-tolerance），用户提议**治本方案**：DeepSeek 支持
`response_format: {"type": "json_object"}`（json mode）——从模型层面强制输出合法
JSON，而非事后解析容错。

## 需求（做了什么）

- [x] `ProviderRequest` 新增 `responseFormat?: 'json'`（provider 契约）
- [x] `OpenAIProvider.textChat`：`responseFormat === 'json' && !funcTool` 时注入
      `body.response_format = { type: 'json_object' }`（json mode 与 function calling
      共用有兼容风险 → 互斥；仅非流式 textChat 生效）
- [x] bootstrap `generateEvent` 调用加 `responseFormat: 'json'`（systemPrompt 已含
      "只输出 JSON"——DeepSeek json mode 要求 prompt 含 "json" 字样 ✓）
- [x] life.ts 保留 fence 剥离 + 裸文本容错（双保险：response_format 治本 + 容错兜底）

## 设计决策

- 只接 generateEvent（唯一明确要求 JSON 输出的高频调用）；对话/问候/摘要为自然文本
  输出，不加 json mode（会改变模型行为）
- json mode 与 funcTool 互斥——未来若 generateEvent 要带工具，需先解除此限制

## 验证

- core 249 + server 74 全过，双包 tsc 干净
- 部署后观察：后续 Life 事件生成不再出现 "is not valid JSON" fallback 日志

## 对账方向确认

- [x] 无 spec 冲突——provider 契约扩展 + ai-life-system §6 补 json mode

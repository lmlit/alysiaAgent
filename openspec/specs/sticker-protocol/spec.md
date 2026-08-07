---
status: frozen
source: docs/superpowers/specs/2026-08-02-sticker-protocol.md
migrated: 2026-08-07
---
# 表情包协议 — 设计文档

> 日期: 2026-08-02
> 状态: 已实现（私聊）/ 群聊受限降级
> 前置: 角色系统（素材入 worldbook）+ QQ 官方适配器

---

## 1. 背景与目标

### 1.1 需求

- 模型**自主决策**何时发表情包、发哪个（关键词触发会显得很怪，已否决）
- 私聊完整可用；群聊因平台限制降级

### 1.2 技术选型：文案内标记协议（非 tool-calling）

**为什么不用 tool-calling**：DeepSeek 不可靠——多次把 tool calls 作为文本输出（`<tool_calls>` 泄漏），链路不稳定。

**方案**：模型在回复文案中直接插入标记 `[表情包:名字]`，发送层解析标记 → 上传图片 → 从正文移除标记。

---

## 2. 协议

### 2.1 注入（core/pipeline/stages/llm-agent.ts）

仅私聊注入（群聊不发图，避免误导模型）：

```
[表情包使用]
你可以用表情包回应情绪（开心/难过/撒娇/困了等），在回复文案中插入标记: [表情包:名字]
可用表情包: 睡觉、开心、……
示例: "晚安好梦哦 [表情包:睡觉]"
约束: 每次回复最多插入一个表情包标记，情绪平淡时不要插入。
```

可用表情包列表动态来自 `memoryManager.listStickers()`（实时同步素材库）。

### 2.2 解析（server/adapters/qq-official.ts sendReply）

```
rawText.matchAll(/\[表情包:([^\]]+)\]/g)
  → stickerResolver(name) → memoryManager.findSticker(name)?.content（图片路径）
  → 上传图片 → 正文移除全部标记 + 压缩多余空行
```

- `stickerResolver` 由 bootstrap 注入：`(name) => core.memoryManager.findSticker(name)?.content ?? null`
- 图片路径去掉前导斜杠（Windows 下 `path.resolve` 会解析到盘根——已踩坑）

### 2.3 发送（QQ 官方 API）

| 场景 | 方式 | 结果 |
|------|------|------|
| 私聊 | multipart 上传 file_data（base64）+ `srv_send_msg=true`（直接发送） | ✅ 实测成功 |
| 私聊（被动态） | 上传 → get_file_info → 媒体消息 | ✅ |
| 群聊 | 上传 + `srv_send_msg=false` + msg_type=7 | ❌ 40011000（被动媒体不可用） |
| 群聊主动 | 带权限主动消息 | ❌ 40034105（需申请权限，4条/月） |

**结论**：QQ 官方 API 群聊被动媒体不可用 → 群聊禁用表情包（详见 memory：[[qq-group-media-limitation]]）。

---

## 3. 素材来源

- **角色包**：`data/roles/*.json`（worldbook content_type=image 条目）→ `listStickers()`
- **米游社爬取脚本**：`packages/server/scripts/fetch-miyoushe.ts`
  - 输入文章 URL / post_id → 解析图片 + 标签 → 下载 → 生成角色包 JSON
  - 踩坑记录：img regex 不能带 g flag（否则 match 返回完整匹配而非捕获组）、Windows curl 路径要转正斜杠、ESM 下用 statSync 而非 require

---

## 4. 调用链

```
[LLMAgent] 系统提示注入表情包协议（仅私聊）
  → 模型回复含 [表情包:睡觉]
  → [RespondStage] → event.send → qqOff.sendReply
    → 正则解析标记 → stickerResolver → 图片路径
    → uploadImage(base64, srv_send_msg=true) → 发送
    → 正文移除标记后按文本发送
```

---

## 5. 待办

- [ ] 生图 AI 接入：模型想发表情包时动态生成图片（memory：[[alysia-todo-ai-sticker-generation]]）
- [ ] 群聊表情包走 OneBot/NapCat 通道（memory：[[qq-group-media-limitation]]）

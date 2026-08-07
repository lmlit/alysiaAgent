---
status: frozen
source: （无旧文档，2026-08-07 治理对账补写）
migrated: 2026-08-07
---
# 图片识别（Vision Bridge）— 设计文档

> 日期: 2026-08-07（补写——实现已存在，原无 spec 覆盖）

## 1. 背景与目标

聊天主模型是纯文本 DeepSeek，无法直接看图。Vision Bridge 为它提供图片理解能力：

```
用户发图片 → 适配器下载图片 → VisionBridge.describe() → GLM-4V-Flash 返回文字描述
→ 描述文本拼入 DeepSeek prompt → DeepSeek 基于描述回复
```

**关键差异**：GLM-4V-Flash（智谱免费视觉模型，OpenAI 兼容 API）要求 base64 **不带**
`data:image/...;base64,` 前缀（纯 base64）。

## 2. 配置（bootstrap 注入）

| 字段 | 说明 | 默认 |
|------|------|------|
| `baseUrl` | 智谱 API | `https://open.bigmodel.cn/api/paas/v4` |
| `apiKey` | 复用 `.env` 的 `EMBED_API_KEY`（智谱） | — |
| `model` | 视觉模型 | `glm-4v-flash`（免费） |

接线：`config.embed?.apiKey` 存在时创建 VisionBridge → `qqOff.setVisionBridge(bridge)`。

## 3. 接口

| 方法 | 签名 | 说明 |
|------|------|------|
| `describe` | `(imageUrl: string, prompt?: string): Promise<string \| null>` | 描述单张图（URL 或本地路径），失败返回 null |
| `describeAll` | `(imageUrls: string[], prompt?: string): Promise<string[]>` | 并发描述多张图，过滤失败 |

**调用流程**：
1. 下载图片 → base64（本地路径直接 readFile；HTTP 用 fetch）
2. POST `${baseUrl}/chat/completions`：`image_url.url` = 纯 base64（无 data URI 前缀）
3. 默认 prompt：`请用1-2句话简要描述这张图片的内容。`；`max_tokens=200, temperature=0.1`
4. 取 `choices[0].message.content`

## 4. 接入点（qq-official 适配器）

图片识别触发：用户消息中的图片。**修复记录**（2026-08-06）：
`data.msg_elements ?? data.attachments` 空数组不穿透——改
`[...(data.attachments||[]), ...(data.msg_elements||[])]` 合并，任一阵列非空即触发。

## 5. 日志（必打）

- 成功：`[Vision] glm-4v-flash → "<描述前80字>" (tokens, ms)`
- API 失败：`[Vision] GLM-4V-Flash error <status>: <errText前200字> (ms)`
- 下载失败：`[Vision] download failed <status>: <url前80字>`

## 6. 已知限制

- 免费模型精度有限，复杂/遮挡图描述可能不准
- base64 无尺寸限制但大图耗时高（日志带 ms 可观测）
- 只有描述文本进主 LLM，无图片内容注入（够用，不扩展）

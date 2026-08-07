---
status: frozen
source: docs/superpowers/specs/2026-07-30-server-optimization.md
migrated: 2026-08-07
---
# 服务端优化 — 设计文档

> 日期: 2026-07-30
> 状态: 草稿
> 项目: alysiaAgent
> 前置: Feature Flag 系统完成

---

## 1. 范围

本次优化聚焦 7 项改动。不做流式输出、`/stop` 命令、WebUI。

---

## 2. 空 @ 处理

### 2.1 问题

群聊中 `@bot` 但没有附带任何文字消息时，当前 adapter 产出的 `messageStr` 为空字符串，Agent 拿到空 prompt 要么不回复要么乱回复。

### 2.2 设计

在 Telegram adapter 的 `toMessageEvent()` 阶段检测：

```
消息只包含 @mention，没有任何有效文本
  → messageStr 设为特殊标记 "[空@]"
  → LLMAgentStage 检测到 [空@] → 跳过 LLM 调用
  → RespondStage 回复固定文案："嗯？怎么啦～（叫我有什么事吗？）"
```

**改动文件**：
- `packages/server/src/adapters/telegram.ts` — `toMessageEvent()` 检测空 @
- `packages/core/src/pipeline/stages/llm-agent.ts` — 检测 `[空@]` 直接设置默认回复
- `packages/server/src/adapters/qq-onebot.ts` — 同上逻辑（OneBot 的 at 机制不同）

### 2.3 Telegram 空 @ 检测逻辑

```typescript
// telegram.ts toMessageEvent()
private toMessageEvent(ctx: Context): MessageEvent | null {
  // ...existing parse logic...
  
  let messageStr = 'text' in msg ? (msg.text || '') : '';
  
  // 空 @ 检测：消息仅包含 mention，没有实质文本
  if (!messageStr.trim()) {
    const hasContent = components.some(c => 
      c.type === 'image' || c.type === 'voice' || c.type === 'sticker' || c.type === 'file'
    );
    if (!hasContent && components.some(c => c.type === 'at')) {
      messageStr = '[空@]';
    }
  }
  // ...
}
```

---

## 3. 群聊 system_reminder

### 3.1 问题

群聊中多人同时发言、话题跳转频繁。Agent 收到的只是一条条孤立消息，看不到"间隙里发生了什么"。

### 3.2 设计

LLMAgentStage 在构建 system prompt 时，检测是否为群聊 + 是否有最近会话历史，如果有就注入一条简短的上下文提醒：

```
[群聊提醒]
当前群聊中有多人发言，请根据对话上下文自然地参与。
如果消息不是对你说的，简单回应或保持沉默即可。
最近发言: {最近3条非当前用户消息的摘要}
```

**改动文件**：
- `packages/core/src/pipeline/stages/llm-agent.ts` — 检测 `event.getMessageType() === GROUP` 时注入

### 3.3 实现

```typescript
// llm-agent.ts process()
async *process(event: MessageEvent): AsyncGenerator<void> {
  // ...
  
  // 群聊 system_reminder
  if (event.getMessageType() === 'group') {
    const recentOthers = history
      .filter(h => h.role !== 'system')
      .slice(-6); // 最近 6 条
    if (recentOthers.length > 0) {
      const ctxSummary = recentOthers
        .map(h => `[${h.role === 'user' ? '群友' : '昔涟'}]: ${h.content.slice(0, 60)}`)
        .join(' | ');
      systemPrompt += `\n\n[群聊上下文]\n最近发言: ${ctxSummary}\n请自然地参与群聊对话。`;
    }
  }
  
  // ...
}
```

---

## 4. chat.ts history 持久化

### 4.1 问题

当前 `chat.ts`（CLI 聊天客户端）的 conversation history 是纯内存数组，最多 60 条。CLI 模式主要用于本地调试，但如果作为长期运行的服务，重启即丢历史。

### 4.2 设计

改为从 EventStore 读取最近消息作为上下文，不依赖内存数组。

```typescript
// chat.ts — 移除内存 history 数组
// 改为每次构建上下文时调用 core.memoryManager.getRecentMessages()
```

这个改动的核心思路：**history 应该由记忆系统管理，而不是 chat.ts 自己维护一份**。

**改动文件**：
- `packages/server/src/chat.ts` — replace in-memory array with `getRecentMessages()`

---

## 5. 结构化日志

### 5.1 问题

全局 `console.log/error`，无时间戳、无级别，生产排查困难。

### 5.2 设计

轻量级 logger，不改动现有调用方式太多：

```typescript
// packages/core/src/utils/logger.ts
export const logger = {
  debug: (msg: string, ...args: unknown[]) => console.debug(`[${ts()}] [DEBUG] ${msg}`, ...args),
  info:  (msg: string, ...args: unknown[]) => console.log(`[${ts()}] [INFO] ${msg}`, ...args),
  warn:  (msg: string, ...args: unknown[]) => console.warn(`[${ts()}] [WARN] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[${ts()}] [ERROR] ${msg}`, ...args),
};

function ts(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
```

**改动范围**：逐步替换 core + server 中的 `console.log/error/warn`。首次覆盖：
- `packages/core/src/index.ts`
- `packages/core/src/eventbus/EventBus.ts`
- `packages/server/src/bootstrap.ts`
- `packages/server/src/adapters/telegram.ts`

---

## 6. Telegram 长文本分片

### 6.1 问题

`telegram.ts` 中 `doSend()` 对 >4000 字符的消息用 `text.slice(0, 4096)` 按 UTF-16 码元截断，会割裂 emoji 和 CJK 字符。

### 6.2 设计

改用 `Intl.Segmenter` 按字形簇 (grapheme clusters) 分片：

```typescript
function splitByGraphemes(text: string, maxLen: number): string[] {
  const segmenter = new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' });
  const chunks: string[] = [];
  let current = '';
  for (const { segment } of segmenter.segment(text)) {
    if (current.length + segment.length > maxLen) {
      chunks.push(current);
      current = '';
    }
    current += segment;
  }
  if (current) chunks.push(current);
  return chunks;
}
```

**改动文件**：
- `packages/server/src/adapters/telegram.ts` — `doSend()` 方法

---

## 7. quick-test.ts 清理

### 7.1 问题

91 行手动测试脚本，绕过 AlysiaCore 直接调 fetch API，不使用 Pipeline/EventBus/Agent。属于早期原型死代码。

### 7.2 设计

**删除**。若需要 smoke test，后续用 vitest 写一个调用 AlysiaCore 的集成测试。

**改动文件**：
- 删除 `packages/server/src/quick-test.ts`

---

## 8. Telegram 消息去重

### 8.1 问题

Telegram API 在某些网络条件下可能重试发送同一条消息，当前 adapter 没有去重逻辑，导致同一条消息被处理两次（两次 EventLog 写入、两次 LLM 调用）。

### 8.2 设计

在 Telegram adapter 中维护一个 `Set<string>` 记录最近处理过的 `message_id`，大小限制 1000 条（LRU 淘汰）。

```typescript
class TelegramAdapter {
  private seenMessages = new Set<string>();
  private static MAX_SEEN = 1000;

  private onMessage(ctx: Context): void {
    const msg = ctx.message;
    if (!msg) return;
    
    const msgId = String(msg.message_id);
    if (this.seenMessages.has(msgId)) return; // 跳过重复
    
    this.seenMessages.add(msgId);
    if (this.seenMessages.size > TelegramAdapter.MAX_SEEN) {
      // 清空最旧的半数
      const entries = [...this.seenMessages];
      this.seenMessages = new Set(entries.slice(entries.length / 2));
    }
    
    // 正常处理...
  }
}
```

**改动文件**：
- `packages/server/src/adapters/telegram.ts`

---

## 9. 实施计划

| # | 任务 | 预计改动量 | 测试影响 |
|---|------|----------|----------|
| 1 | 空 @ 处理 | telegram.ts + llm-agent.ts (~30行) | 新增 pipeline test |
| 2 | 群聊 system_reminder | llm-agent.ts (~15行) | 新增强 pipeline test |
| 3 | history 持久化 | chat.ts (~20行删减) | 无测试影响（chat.ts 无测试） |
| 4 | 结构化日志 | 新建 logger.ts + 改 ~8处调用 | 无测试影响 |
| 5 | 长文本分片 | telegram.ts (~15行) | 无测试影响（server 无测试） |
| 6 | quick-test 清理 | 删 1 个文件 | 无影响 |
| 7 | 消息去重 | telegram.ts (~15行) | 无测试影响 |

**全部改动后运行 187 个测试确保通过。**

---

## 10. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-30 | 初始设计：7 项服务端优化 |

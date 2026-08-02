# Pipeline 数据契约类型化 & 记忆检索修复 — 设计文档

> 日期: 2026-07-30
> 状态: 草稿
> 项目: alysiaAgent
> 前置: 架构问题审查

---

## 1. 背景

架构审查发现两个关联问题：

1. **记忆检索形同虚设**：`MemoryRetrievalStage` 依赖 `event.getExtra('search_results')`，但没有任何 Stage 设置这个值。`MemoryManager.read()` 定义了完整的向量搜索 + Worldbook 匹配逻辑，但从未被调用。
2. **Stage 间数据传递无类型约束**：`setExtra(key, value)` / `getExtra(key)` 用裸字符串 key，拼写错误、遗漏设值、类型不匹配在编译期完全不可见。

**根因一致**：Pipeline extras 没有类型化的契约，Stage 之间的数据依赖靠"约定"而非"编译器强制执行"。

---

## 2. 设计目标

| 目标 | 说明 |
|------|------|
| **编译期安全** | extras key 拼写错误、类型不匹配 → TypeScript 编译报错 |
| **自文档化** | 一眼看清 Pipeline 中所有 Stage 间传递的数据 |
| **修复记忆检索** | MemoryRetrievalStage 改为主动调用 MemoryManager.read()，不再等待无人设置的 extras |
| **向后兼容** | 187 测试全通过 |

---

## 3. PipelineExtras — 类型化的 Stage 间数据契约

### 3.1 接口定义

```typescript
// packages/core/src/pipeline/types.ts

/** Pipeline Stage 间传递的数据契约。
 *  每个 key 对应一个 Stage 产出的数据，供下游 Stage 消费。
 *  新增 key 必须先在此接口中声明，否则编译报错。 */
export interface PipelineExtras {
  /** MemoryRetrievalStage → LLMAgentStage: 拼接好的 System Prompt 片段 */
  memory_context: string;
  /** MemoryRetrievalStage → LLMAgentStage: 向量搜索 + Worldbook 匹配结果 */
  search_results: import('../memory/types.js').SearchResult[];
  /** MemoryRetrievalStage → LLMAgentStage: Worldbook 触发条目 */
  worldbook_triggers: import('../memory/types.js').WorldbookEntry[];
  /** LLMAgentStage → RespondStage: Agent 生成的回复 */
  response_chain: import('../platform/chain.js').MessageChain;
  /** LLMAgentStage (POST) → stats: Token 用量快照 */
  _token_usage: { input: number; output: number; total: number };
  /** chat.ts CLI → LLMAgentStage: 跨轮次对话历史 */
  conversation_history: Array<{ role: string; content: string }>;
}
```

### 3.2 MessageEvent 方法签名变更

```typescript
// 之前
setExtra(key: string, value: unknown): void;
getExtra<T>(key: string): T | undefined;

// 之后：key 必须是 PipelineExtras 的合法属性名
setExtra<K extends keyof PipelineExtras>(key: K, value: PipelineExtras[K]): void;
getExtra<K extends keyof PipelineExtras>(key: K): PipelineExtras[K] | undefined;
getExtra<K extends keyof PipelineExtras>(key: K, defaultValue: PipelineExtras[K]): PipelineExtras[K];
```

效果：
- `event.setExtra('search_resluts', ...)` → **编译报错**（拼写错误）
- `event.getExtra('search_results')` → 返回类型自动推断为 `SearchResult[]`
- `event.setExtra('search_results', "wrong")` → **编译报错**（类型不匹配）

### 3.3 非流水线 extras 的处理

Adapters 和临时数据仍然可以用 `setExtra` 存任意 key，但需要显式绕过类型约束。提供一个 escape hatch：

```typescript
/** 存储非 Pipeline 契约的临时数据（adapter 内部使用）。
 *  请尽量使用 PipelineExtras 中声明的 key。 */
setArbitraryExtra(key: string, value: unknown): void;
getArbitraryExtra<T>(key: string): T | undefined;
```

---

## 4. 记忆检索修复

### 4.1 当前问题

```
LLMAgentStage
  └→ 需要 memory_context (System Prompt)
       └→ MemoryRetrievalStage 应该在 PRE 阶段设置
            └→ 当前: 只读 extras('search_results') + extras('worldbook_triggers')
            └→ 问题: 无人设置这两个 extras
            └→ 结果: assembleWithWorldbook('chat', [], []) → 无搜索结果注入
```

### 4.2 修复方案

`MemoryRetrievalStage.process()` 改为主动调用 `MemoryManager.read()`，不再被动等待 extras。

```typescript
// 修复前
async process(event: MessageEvent): Promise<void> {
  const triggers = (event.getExtra('worldbook_triggers') || []) as WorldbookEntry[];
  const retrieved = (event.getExtra('search_results') || []) as SearchResult[];
  const mode = event.pipelineMode;
  const longTermMemory = await this.memoryManager.assembleWithWorldbook(mode, triggers, retrieved);
  // ...
}

// 修复后
async process(event: MessageEvent): Promise<void> {
  // ★ 主动调用 MemoryManager.read() 执行向量搜索 + Worldbook 匹配
  const mode = event.pipelineMode;
  const readResult = await this.memoryManager.read({
    query: event.messageStr,
    mode,
    limit: 5,
  });

  // 写入 extras 供下游 Stage（如 LLMAgentStage）使用
  event.setExtra('search_results', readResult.retrieved);
  event.setExtra('worldbook_triggers', readResult.worldbook_triggers);

  // 组装长期记忆
  const longTermMemory = await this.memoryManager.assembleWithWorldbook(
    mode,
    readResult.worldbook_triggers,
    readResult.retrieved,
  );
  // ...
}
```

### 4.3 数据流修复后

```
用户消息
  → PIIFilterStage: 脱敏
  → MemoryIngestStage: 写入 EventLog
  → WorldbookStage: (no-op, deprecated)
  → MemoryRetrievalStage: ★ MemoryManager.read(query) → 向量搜索 + Worldbook 匹配
    → setExtra('search_results', ...)      ← 类型安全
    → setExtra('worldbook_triggers', ...)   ← 类型安全
    → setExtra('memory_context', ...)       ← 类型安全
  → LLMAgentStage: getExtra('memory_context') → 注入 System Prompt
  → RespondStage: getExtra('response_chain') → 发送回复
```

---

## 5. 实施计划

### Phase 1: PipelineExtras 类型契约

- [ ] 1.1 在 `pipeline/types.ts` 中定义 `PipelineExtras` 接口
- [ ] 1.2 修改 `MessageEvent.setExtra/getExtra` 为类型安全的泛型签名
- [ ] 1.3 添加 `setArbitraryExtra/getArbitraryExtra` escape hatch
- [ ] 1.4 更新所有 Stage 中的 `setExtra/getExtra` 调用，使用类型化的 key
- [ ] 1.5 更新 adapter 中的 extras 调用，非契约 key 改用 `ArbitraryExtra`
- [ ] 1.6 运行测试，确保编译通过且 187 测试全绿

### Phase 2: 记忆检索修复

- [ ] 2.1 `MemoryRetrievalStage.process()` 改为主动调用 `MemoryManager.read()`
- [ ] 2.2 将 `read()` 返回的结果写入 `PipelineExtras`
- [ ] 2.3 清理不再需要的默认值 fallback (`|| []`)
- [ ] 2.4 移除 `WorldbookStage` 中残留的无用逻辑（如果 Worldbook 匹配已由 `MemoryManager.read()` 处理）
- [ ] 2.5 运行测试

### Phase 3: 验证

- [ ] 3.1 全部 187 测试通过
- [ ] 3.2 TypeScript 编译零错误
- [ ] 3.3 手动验证：启动 CLI 聊天，确认 `memory_context` 包含向量搜索结果

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-30 | 初始设计：PipelineExtras 类型契约 + 记忆检索修复 |

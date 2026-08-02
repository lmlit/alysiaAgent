# 画像事实来源标记修复（Profile Fact Sourcing）

> 日期：2026-08-02 · 状态：✅ 已实现 · 类型：Bug 修复

## 背景：用户报告"上下文丢失"的调查

用户 QQ 反馈：早上说过"今天周末不上班"，bot 却回复"去上班啦？工作加油～搞定日志系统呀！"，怀疑上下文丢失 / 重启导致。

## 调查结论（三层验证）

1. **不是重启导致的**：EventLog/facts 全部持久化在 sqlite，重启不丢。实测 EventLog 完整（08-01 至今全部 115 条用户消息）。
2. **短期上下文确实有窗口**：短期记忆 = `getRecentMessages(10)` 最近 10 条消息。04:52 的"周末不上班"在 07:54 时已被 15 条消息挤出窗口 → 短期注入缺失。
3. **长期记忆兜住了但被"打折"**：facts 里有"用户周末不上班"且实际注入 prompt，但**所有 fact 都标着"（待确认）"**——因为 `ProfileExtractor.extract()` 硬编码 `source: 'inferred'`，尽管 evidence 是用户原话。LLM 看到"（待确认）"即打折对待，而 basics（无标记）里的"从事系统优化相关工作"被优先采信 → 顺着"直奔公司"回"工作加油"。

另注：**"统一日志系统"是用户 08-01 18:40 亲口说的**（"顺便优化一下系统 现在在统一日志系统"），bot 记得没错，不是幻觉污染。

## 修复内容

### 1. `ProfileExtractor.extract()` — 事实来源标记（核心修复）

- LLM 提取 prompt 增加 `directly_stated` 字段（用户是否直接陈述该事实）
- `directly_stated: true` → `source='user'`；否则 `inferred`
- 此前硬编码 `'inferred'`，导致 PromptAssembler 的 `[你说过]` 标记（v2 设计）从未生效，所有事实显示"（待确认）"
- mergeFacts 已有保护：`user` 来源不可被 `inferred` 覆盖（低置信度推断不会冲掉用户亲口说的）

### 2. 存量数据迁移（一次性，已执行）

- 按 evidence 与 EventLog 用户原话的包含匹配修正 source：23 条 active facts → **21 条升级为 `user`**，2 条保持 `inferred`（evidence 为 LLM 概括，非精确原话）
- basics 措辞收紧："从事系统优化相关工作的技术型玩家" → "喜欢优化系统、写代码的技术型玩家"（避免"工作"类过度推断引导 bot 话题）

## 上下文注入现状（回答"注入几轮"）

| 层 | 来源 | 量 |
|----|------|-----|
| 短期记忆 | `MemoryRetrievalStage` → `getRecentMessages(10)` | 最近 10 条消息 |
| 会话摘要 | `PromptAssembler` → `conversationStore.getRecent(3)` | 3 条摘要（非原文） |
| 长期事实 | 活跃 facts（按置信度降序 + key 去重 + `[你说过]`/`(待确认)` 标注） | 受 token budget |
| 画像 | basics + preferences | 固定 |
| 检索 | 向量/文本 top-k | 5 条 |
| `conversation_history` | **死代码**：llm-agent 读取但无 stage 写入 | 0 |

## 验证

- `ProfileExtractor.test.ts` 新增 3 个用例（user/inferred 判定、merge 保护），8/8 通过
- core 全量 213/215（2 个失败为需真实 API key 的 e2e，与本次无关）
- 注入实测：prompt 中"用户周末不上班 [你说过]" ✅，basics 已收紧 ✅

## 后续优化（已实施）

- **短期记忆窗口扩容（2026-08-02 已实施）**：`getRecentBySession` 支持 `since` 时间窗口参数；`MemoryRetrievalStage` 改为最近 **2 小时 + 最多 20 条**（原为固定 10 条，高频聊天半天即挤出早间信息）。EventStore 新增 3 个测试验证时间窗口/上限/向后兼容。

## 已知限制 / 待办

- `conversation_history` 死代码可清理，或由 MemoryRetrievalStage 实际写入（供流式/前端用）
- 新增/修改记忆系统方法需同步 `docs/Web-API-Design.md`

# Change Proposal: fix-empty-embed-query

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-19
- **类型**: FIX（静默失败 / 日志噪声）
- **状态**: **archived（2026-10-19）**
- **影响 spec**: `memory-system`（新增契约：空查询不请求 embedding）

## 动机（为什么做）

看门狗上线后第一眼就从日志尾部看出这条（用户让我「做完查一下」）：

```
[WARN] [Memory] vector search failed, fallback to text search:
       Embed API error 400: {"error":{"code":"1213","message":"未正常接收到prompt参数。"}}
[INFO] [memory/read] query="" → 召回 5 条 / worldbook 0 条 / context 2981 字
```

**根因**：查询是**空字符串**（dsh 会话挂载预热 / 系统组装时没有用户原话），
而我们仍然请求了一次 embedding —— 智谱对空 prompt 直接 400。

两层问题：
1. **逻辑错**：没有查询文本就没有"语义相似"可言，那次请求本来就不该发；
2. **噪声**：每次这类组装都打一条 WARN + 一条 400，**真故障会被它淹掉**
   （今晚的 undici 崩溃、站点断掉都更难被发现，原因之一就是这种噪声）。

## 需求（做什么）

- [ ] `MemoryManager.read`：`query.trim() === ''` ⇒ 直接走文本检索，**不碰 embed**；记 `debug`，不是 WARN
- [ ] `embed`（`al:embed` 模块）：空文本**不发 HTTP 请求**，抛明确错误（便于定位调用方）
- [ ] 测试钉住："空文本 ⇒ fetch **没被调用**"（不需要真连 API）

## 设计决策

1. **在 read 层跳过，而不是在 embed 层兜底成零向量**：零向量会让向量检索返回"随机相似"的垃圾结果，
   比走文本检索更糟。**没有查询就没有语义检索**，老老实实退回文本。
2. **embed 层仍要守**：防止别的调用方（ingest / chunk 索引）拿空文本要向量 —— 那里会浪费往返，
   而且 400 会混进日志。

## 对账方向确认

- [x] 与契约"判据取事实"一致：这条不是"让模型自己判断要不要检索"，而是**代码里就不发**
- [x] 涉及 Web API？否（`POST /api/memory/read` 行为不变，空 query 照样返回 `[关于你]` 等块）

## 测试计划

- `packages/core/tests/embed-empty-guard.test.ts`（4 例）：空串/纯空白不发请求；正常文本照发；
  服务端错误照抛
- 真机：`POST /api/memory/read {"query":""}` ⇒ 日志只有 `[memory/read] query="" → 召回 5 条`，
  **没有** `Embed API error 400`

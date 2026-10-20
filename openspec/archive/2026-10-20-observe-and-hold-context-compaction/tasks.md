# Tasks: observe-and-hold-context-compaction

## ① 留痕

- [x] `CONTEXT_COMPACT_TRIGGER_TOKENS = 8_000` 具名常量（含"数字来源不明 + 两把尺子不可比"的说明）
- [x] 触发日志：`[Compact] input=N > 8000 → 触发会话摘要 session=…`
- [x] 成功日志：`[Compact] 摘要完成 → 恢复截断`
- [x] 失败日志：`[Compact] 摘要失败 → **暂停截断**（保住未摘要的对话）：原因`

## ② 暂缓截断

- [x] `memory/compaction-status.ts`：`markCompactionFailed` / `clearCompactionFailed` / `isCompactionFailed`
      （有界 `MAX_ENTRIES=200`、`TTL=30min`、读取时回收过期条目、测试用 `_reset`）
- [x] `agent/truncation-policy.ts`：`decideTruncation()` 三种结局 + `HARD_CEILING_FACTOR=2`
- [x] `AgentRunner`：`applyTruncation()` 统一 `run()` 与 `runStream()`（防两条链路分叉）
- [x] hold 时用 `warnThrottled` 限频（否则每步一条淹日志）
- [x] `AgentContext.estimateTokens()` 抽出（**不改口径**，注释标注不准）

## 测试（10 条）

- [x] 压缩正常 ⇒ `truncate/normal`（正常路径零变化）
- [x] 压缩失败 ⇒ `hold`
- [x] 压缩失败 + 超硬上限 ⇒ `truncate/over-hard-ceiling`
- [x] 硬上限边界（正好 2 倍 hold，+1 才截断）
- [x] 状态：标记/清除、按 session 隔离、TTL 过期（读取即回收）、有界 200
- [x] `estimateTokens` 现状锁（`length/3`）—— 改口径时它会红

## 验证

- [x] `tsc` core 通过
- [x] 全量（Node 24，免 API）：**144 文件 / 1781 测试全绿**

## 收尾

- [x] `alysia-architecture` §6.4（六条契约）
- [x] 归档 + 索引 + TODO + HANDOFF

## 未做（明确记录）

- **mid-session 压缩的"塞回去"**：把被丢的旧轮次压成一段摘要插回上下文。
  现有压缩是"整段会话 → 摘要进 `[最近对话]`"，**不是**"被丢的那几轮 → 摘要插回"。
  这是另一种能力（要设计插入位置、要防"摘要的摘要"走样），独立 change。
- `length/3` 口径修正：等"估算 vs 真实 token"的分布数据。

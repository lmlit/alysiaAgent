# Change Proposal: observe-and-hold-context-compaction

## 元信息

- **日期**: 2026-10-20
- **类型**: FIX + OBSERVABILITY（**B 类：行为必变**，只在失败路径生效）
- **状态**: `applied`
- **影响 spec**: `alysia-architecture` **§6.4（新增：上下文预算、截断与压缩）**

## 这条要解决什么

两件事，都是"一直存在但没被写下来"的：

### ① 压缩触发点完全无痕

```ts
// 改前
if (usage.input > 8_000) {
  this.ctx.memoryManager.onSessionEnd(...).catch(err => logger.error('LLMAgent onSessionEnd failed:', err));
}
```

8000 是裸数字：没有注释说明怎么来的、触发不打日志、成功/失败都不计数。
**没人知道线上触发过几次**——这跟这个项目在 KI-1/KI-11 上栽的形态一模一样。

### ② 压缩与截断之间有个洞（更严重）

两条链各跑各的，没有联动：

1. 某轮 `usage.input > 8000` → 触发摘要（**fire-and-forget**）
2. 下一轮 `ctx.truncate(maxTokens)` 把最早几轮 `splice` 掉
3. 摘要**失败了**（LLM 超时/空响应——本项目在这上面栽过三次）

⇒ 那几轮**从上下文消失、也没变成摘要**。它们还在 DB 里（会话结束能摘到），
但在**当下这个会话里**她真的不记得了，而日志上只有一行 `error`。

## 需求

1. **留痕**：`CONTEXT_COMPACT_TRIGGER_TOKENS` 提成具名常量（附"这个数字怎么来的/为什么不准"的说明）；
   触发打 `[Compact] input=N > 8000 → 触发会话摘要`；完成/失败分别打 `[Compact] 摘要完成 / 摘要失败 → 暂停截断`
2. **失败登记**：新增 `memory/compaction-status.ts`（进程内按 session 登记，**有界 200 / TTL 30min / 成功即清**）
3. **暂缓截断**：`AgentRunner` 截断前查状态，失败则 `hold`
4. **硬上限兜底**：估算 > `maxTokens × 2` 时**仍截断**并 warn —— 不截断会超模型上下文 400
5. **抽纯函数**：`decideTruncation()` 返回三种结局，可穷举测试；`run()` 与 `runStream()` **共用**
6. 顺带把 `length/3` 的估算抽成 `AgentContext.estimateTokens()`，并在注释里**明确标注它不准**（不改口径）

## 为什么用模块级注册表而不是加构造依赖

写入方是 pipeline 的 `llm-agent`，读取方是 `AgentRunner` —— 两者**没有共享对象**。
给 `AgentRunner` 加一个 `memoryManager` 形参会牵动所有构造点与 30+ 测试
（**为一个小状态付大代价**）。

改用模块级注册表（与既有 `self-notice.ts` 同形状）：零构造改动、可显式 clear、
有界 + TTL 三条纪律都写在模块里。

## 不做什么

- **不改 `length/3` 的口径**：它在正常路径被 8000（真实 token）兜着，
  危害远小于我最初的判断。要改必须先有"估算 vs 真实 token"的分布数据
- 不改 `maxContextTokens` 默认 16000
- 不做"把旧轮次压成摘要塞回上下文"（那是另一种能力，见下）

## 回滚

- ① 纯观测，回滚 = 删日志
- ② 回滚 = 让 `decideTruncation` 永远返回 `normal`（一行），或删掉 `hold` 分支
- 正常路径（压缩没失败）**行为完全不变**：`isCompactionFailed` 为 false ⇒ 直接 `truncate`

## 对账方向

spec 从未写过"压缩与截断的关系" ⇒ 本 change **补 doc**（§6.4 六条契约）+ 修 impl。

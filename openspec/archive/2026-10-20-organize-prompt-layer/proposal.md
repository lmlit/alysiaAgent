# Change Proposal: organize-prompt-layer

## 元信息

- **日期**: 2026-10-20
- **类型**: REFACTOR（**A 类：行为不变**，有硬证据）
- **状态**: `applied`（proposal 与 apply 同轮）
- **影响 spec**: `memory-system` §4.1.5（新增「提示词资产与块投放策略」）
- **用户授权**: 「记下这个变更…提示词注入节点有抽出来吗」→「AB 都做吧」

## 这条要解决什么

盘提示词层时发现两个**结构性**缺口（不是缺功能）：

### 缺口 1：记忆链路的提示词内联在业务代码里

| 提示词 | 原位置 | 槽位 |
|---|---|---|
| 会话摘要 | `SessionEndProcessor` 内联常量 | `session.summary`（JSON） |
| 画像提取 | `ProfileExtractor.extract` 内联 | `profile.extract`（JSON） |
| 纠错判断 | `ProfileExtractor.detectCorrection` 内联模板 | `profile.extract` |
| 深度画像 | `CronProcessor.deepProfile` 内联 | `profile.deepRewrite`（**纯文本**） |

对照：人格（`core/src/persona/*.md`）与生活（`server/src/prompts/life.ts`）早外置了 ——
**记忆这一支是漏掉的**。后果：改提示词要动业务文件、无法集中审阅、
验证脚本各自复制一份。

### 缺口 2：块的"优先级"是隐式的

`PromptAssembler` 里"哪块被丢"由**调用顺序**决定：谁先 `reserve` 谁先活。
于是「人格绝不能被丢」**没有任何一处写明** —— 它只是恰好排得早。

10-15 那次事故（31 条自省吃满 3200 预算、`[关于我]` 整块被丢、她一条都读不到）
就是这个结构的必然结果：**顺序即优先级，而优先级没被记录过**。

## 需求

1. **提示词外置**：4 处搬到 `packages/core/src/prompts/memory.ts`
2. **块策略表**：`CHAT_BLOCK_POLICY` / `CODE_BLOCK_POLICY`（`required` / `optional`）
3. **丢弃留痕**：预算不足时打一行 `[Prompt] 预算不足，本轮丢弃 N 块：a, b, c`
4. **行为特征快照**：`prompt-assembler-characterization.test.ts`，4 个场景拍底片

## ★ 怎么证明"行为不变"（这是本 change 的核心交付物）

光跑测试**不算证明** —— 测试是 mock 的，只能证明"调用发生了"。

| 缺口 | 证据 |
|---|---|
| 提示词搬移 | 一次性脚本把 `git show HEAD:<file>` 的原文与新常量做**字面量内容**比对（剥掉引号/`+`/声明前缀），4/4 逐字相同（464 / 637 / 212 / 42 字符） |
| 块策略重构 | **characterization 快照**：重构前拍底片（4 个场景，覆盖 rich / empty / **预算饥饿** / code），重构后跑同一快照**逐字未变**、且**没有 `-u`** |

纪律写进测试文件头：**不许 `vitest -u`**，否则底片退化成装饰。

## 不做什么

- **不改**任何提示词**内容**（改内容 = 行为变更，要独立 change 说明意图）
- **不改**块顺序、不改预算数值（3200 / 2450 原样）
- 不引入"插件式块注册表"（需要把每个块的构建函数改成惰性 builder，
  属于更大重构；本 change 只把**策略**显式化，已能回答"谁能被丢"）
- 不合并 `profile.extract` / `profile.deepRewrite` 两个槽（输出契约相反，合并必炸）

## 唯一的可观测变化

丢弃日志：原来 `life` 块被丢时打 `logger.debug('[Life] life block skipped (budget)')`，
现在合并进统一的 `logger.info('[Prompt] 预算不足，本轮丢弃 …')`（chat 与 code 各一行）。

**请求体与 prompt 文本零变化**（快照证明）；只是"丢了多少"从 DEBUG 提到 INFO。

## 对账方向

spec 从未声明过"块有优先级"这件事 ⇒ 本 change **补 doc**（§4.1.5），不是改 impl 迁就。

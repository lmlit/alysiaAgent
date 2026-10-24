# Change Proposal: pin-memory-read-seams

## 元信息

- **日期**: 2026-10-25
- **类型**: FIX（code review 遗留四项，都是「不会报错」那类）
- **状态**: applied（待部署+归档）
- **影响 spec**: `memory-system`（§4.1.x 块表策略 —— 新增契约 6/7）
- **来源**: `align-dsh-memory-blocks-with-scope` 实现后的自审（F3/F5/F7/F11）

## 动机

四个遗留项有个共同点：**它们都不报错**，所以只能靠人记住。
本项目已经因为这类东西栽过多次（世界书死参数 22 天、意图标签空转、衰减不可达 2 个月），
所以这轮的处置方式不是"修掉就完"，而是**改成机器拦得住**。

| # | 问题 | 处置 |
|---|---|---|
| **F11** | `AssembleOptions` / `AssembleReport` 没从 `memory/index.ts` 导出 ⇒ core 不暴露深路径 ⇒ 包外只能写 `any` | **补导出**（含两个块策略表与 `ChatBlockKey`/`CodeBlockKey`） |
| **F7** | 世界书"注入 0 条"的告警把「全 image」和「scope 不符」混成一句、无计数 ⇒ 看得见但诊断不了 | 抽成**纯函数** `worldbookSkipDiagnosis()`，分类计数 + 给出不同处置 |
| **F3** | 少给 `worldbookScope` 与"库里确实没条目"在日志里**同形**（都是 `注入 0 条`） | `/api/memory/read` 日志追加 `未给 worldbookScope ⇒ 世界书不注入` |
| **F5** | 世界书排在 life/memories **之前**，预算紧时先挤掉它们 | **不改行为**（那是有记录的权衡），改为**用测试钉住顺序** |

## 关键决策

**F5 为什么不改**：`CHAT_BLOCK_POLICY` 的注释里早写了代价（「预算紧时先被挤掉的是它后面的两块」）。
在**没有运行数据**的前提下改优先级 = 拍脑袋动行为，正是本项目反复强调不要做的事。
钉住它比改掉它更值：将来谁想改，必须先改测试并说清"谁该让位"。

**F7 为什么抽纯函数**：不是因为"分层好看"，是因为**内联字符串没法测** ——
`warnThrottled` 有限频，同一 tag 第二次调用被吞，于是"断言文案里有 X"在第二个用例里
会拿到空字符串。这是实测踩到的（第一版 spy 断言就是这么红的）。

## 对账方向确认

- [x] **改 impl**：spec 早已声明"块的优先级必须显式声明""丢弃必须留痕"，impl 补齐诊断与导出
- [x] 涉及 Web API？`POST /api/memory/read` **请求/响应签名不变**，只加一行日志文本

## 测试计划

新增 `packages/core/tests/memory/unit/pin-memory-read-seams.test.ts`（8 例）：

- F11：选项/回执/两张块表都能从 `@alysia/core/memory` 拿到（`satisfies` 编译期校验类型导出）
- F5：chat 表顺序 `recentConversations → worldbook → life → memories`；`required` 只有三个
- F7：全 image ⇒ 点名 `image 型 2 条` 并指向 `content_type`；scope 不符 ⇒ 说「**配置缺口，不是故障**」；
      两类并存 ⇒ 明说并存；命中 0 条 ⇒ **不告警**（那不是异常）
- F3：`blocks='chat'` 不给 scope ⇒ 世界书**不注入**（与 2026-10-24 之前逐字相同，语义不变）

全量：**163 文件 / 1919 用例**。

## 风险

- ⚠️ 低。F11 是加导出（不破坏现有面）；F7/F3 只改日志文案；F5 只加断言不改行为。

# Change Proposal: assembler-block-registry

## 元信息

- **日期**: 2026-10-25
- **类型**: REFACTOR（结构切面，**零行为变更**）
- **状态**: **archived**（2026-10-25 已部署：镜像 0a5c342346ee、健康 200、容器 healthy、回滚点 `rollback-20261025-021012`）
- **影响 spec**: `memory-system`（§4.1 契约 3 → 升级为「注册表」；新增契约 8）
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的 **P8 第 2 步**
- **用户原话（动因）**：「为什么我们的组装器不兼容这些，**多做点接口切面，后续如果要加东西才好加**」

## 动机

`assembleChat()` 是一个 400 多行的函数，**三件事分散在三处**：

| 事实 | 原来写在哪 |
|---|---|
| 有哪些块 | `ChatBlockKey` 联合类型（文件头） |
| 谁 required | `CHAT_BLOCK_POLICY` 字面量表（文件头，**手写第二份**） |
| 谁先谁后 | **函数体里 `pushChatBlock()` 的调用顺序**（隐式） |
| 这块钱从哪来 | 散落在各段注释里 |
| 会不会写库 | **完全没地方写** |

后果（都是真发生过的）：
- 顺序即优先级，而优先级在 10-15 之前**没被记录**⇒ `[关于我]` 整块被 31 条自省挤掉、22 天无人发现
- 「加一块」必须改函数体中部，且要同时在两处登记（类型 + 策略表）—— 漏一处不会报错
- `pendingConfirm` 块的数据源 `listPendingConfirmFacts()` 内部会 `expireStaleFacts() → writeFacts()`
  ⇒ **每轮组装 prompt 都可能写 DB**，而这件事**在代码里没有任何一处声明**

## 需求（做什么）

- [x] 新增 `packages/core/src/memory/block-registry.ts`：`BlockSpec` 注册表
      （`key` / `policy` / **`effect: 'read' | 'write'`** / `source` / `note?`），
      数组顺序 = 组装顺序 = 预算优先级
- [x] `CHAT_BLOCK_POLICY` / `CODE_BLOCK_POLICY` 改为**由注册表派生**（不再手写第二份）
- [x] 导出 `CHAT_BLOCK_ORDER` / `CODE_BLOCK_ORDER` / `WRITE_EFFECT_CHAT_BLOCKS`
- [x] `PromptAssembler.ts` 只 re-export，不再保留定义
- [x] `memory/index.ts` 公开注册表（包外能回答"她这轮读什么、谁优先、哪块会写库"）
- [x] spec `memory-system` 契约 8 记录注册表 + `effect` 语义

## 关键决策

**为什么把 `effect` 写进注册表**：这不是装饰。`pendingConfirm` 是**读路径带写副作用**——
它是 KI-5 里"吞掉一次写失败而日志看不出来"的那一处。声明 `effect: 'write'` 之后：
① 这件事**可查**（注册表就是清单）；② **可测**（`WRITE_EFFECT_CHAT_BLOCKS === ['pendingConfirm']`）；
③ 后续可以让「只读场景跳过写块」变成机械判断，而不是靠人记得。

**本轮为什么不改掉那个写**：改它要动 `listPendingConfirmFacts()` 的语义（是否顺手清理过期事实），
那是行为变更、且牵扯过期清理的时机。**先显式化，再决定要不要动** —— 顺序不能反。

**为什么不动 `assembleChat` 的函数体**：那才是"真正的拆块重构"，风险高。
本步只把**元数据**收成一处，函数体里仍是逐个 `pushChatBlock`。
`零行为变更`的证明标准是 characterization 快照**逐字不变**（已满足）。

## 对账方向确认

- [x] 纯结构：spec 里"优先级必须显式声明"的要求本就存在，本 change 让它**名副其实**
- [x] 涉及 Web API？**否**

## 测试计划

- [x] **characterization 快照 4/4 逐字通过**（这是"零行为变更"的唯一可信证明，未 `-u`）
- [x] 新增 `block-registry.test.ts`（10 例）：
      chat 13 / code 6 全部登记且无重复；策略**由注册表派生**（不是第二份手写）；
      `required` 只有三个；`source` 非空；
      ★ `WRITE_EFFECT_CHAT_BLOCKS === ['pendingConfirm']` 且该块的 `note` 必须写明
      `expireStaleFacts/writeFacts`（否则这条声明会变成没人敢动的黑盒）；code 表全纯读
- [x] 全量：**164 文件 / 1929 用例**

## 风险

- ⚠️ 低：只搬元数据，函数体未动；快照兜底。
- ⚠️ 后续注意：注册表顺序若被改，快照会变（会红），这是**故意的** —— 见契约 6。

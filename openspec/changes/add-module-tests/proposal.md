# Change Proposal: add-module-tests

## 元信息

- **日期**: 2026-10-01
- **类型**: MODIFY（补测试 + 模块日志走注入）
- **状态**: proposed
- **影响 spec**: `module-kernel`（§3 单测要求）
- **上游**: `modularize-core-assembly`（P1）的 P2 阶段

## 动机（为什么做）

P1 把 `AlysiaCore.start()` 拆成 13 个模块，但模块本身**只有整机冒烟测试兜底**——
`tests/index.smoke.test.ts` 能发现「装不起来」，发现不了「某个模块的配置门控失效」。

具体缺口：
- `codeMode` 门控若失效，表现是「服务端偷偷多了 shell 工具」，**不会有任何报错**
- `al:vector` 的失败降级若退化成中止整树，只在 LanceDB 恰好坏掉时才暴露
- 采样槽若没真的进请求体，只在线上模型返回空响应时才暴露

## ★ 关于「拆到 modules/<name>/ 独立目录」——本 change 不做

P2 原计划有两件事：① 把模块拆到独立目录 ② 每个模块补单测。

**只做 ②。理由：① 在当前规模下是纯机械搬运，无可读性或正确性收益。**

现状：4 个主题文件（resources / memory / capabilities / loop），最长 190 行。
拆成 13 个文件后是 13 个 10-60 行的碎片，导航成本反而上升。

**什么时候该做 ①**：P3 加进 server 侧 ~7 个模块后，`modules/` 会到 ~20 个模块，
主题分组开始别扭；且 P4 要给模块配 `prompts/` 资源目录——那时目录结构才有意义。
**届时作为 P3 的一部分做，而不是现在做。**

（这是一次对既定计划的有意偏离，理由记录在此，便于后续对账。）

## 需求（做什么）

- [x] `tests/modules/` 脚手架：`runModule()` 在隔离宿主里跑单个模块，依赖用 stub 喂
- [x] `resources.test.ts`：db schema / **vector 失败降级** / embed 请求体 / **采样槽进请求体**
- [x] `capabilities.test.ts`：**codeMode 门控**（含子开关）/ provider 注册 / 缺配置响亮失败
- [x] `loop.test.ts`：**Coalescer 同一实例** / 7 段顺序 / boot 生命周期
- [x] `memory.test.ts`：4 资源 → MemoryManager / **vector=null 降级仍可构造** / seed 副作用
- [x] 模块内部日志改用 `ctx.logger`（内核注入）而非模块级全局 logger

## 设计决策

**决策 1：模块日志走 `ctx.logger`**

原先 `loop.ts` / `resources.ts` / `memory.ts` / `capabilities.ts` 都 import 全局 `logger`，
绕过宿主注入的日志器——**模块在隔离测试里注入的日志器收不到它们**，
于是「模块日志」这类断言写不出来。

改动：`apply(ctx)` 内一律用 `ctx.logger`；两个独立导出函数
（`registerChatTools` / `loadRolePackages`）加 `log` 形参，默认值仍是全局 logger
（`AlysiaCore` 的公开方法继续走默认）。

这是**行为上的微小变更**：宿主默认 logger 就是全局 logger，所以生产输出不变；
变的是「宿主可以替换日志器」这个能力变得真正可用。

**决策 2：不 mock 被测模块内部，只 stub 它的**依赖**

`runModule` 通过 `stub(name, value)` 预置依赖服务，被测模块本身跑真实代码。
避免「测的是 mock」——那正是 P1 那次 `OpenAILLMService` 静默违约能藏住的土壤。

**决策 3：断言写「为什么」**

每条断言的 `expect(..., '理由')` 里带上失效后果
（如「破坏了不会报错」「这是原语义不是漏改」），让后来者知道**动了它会怎样**。

## 对账方向确认

- [x] 与现有 spec 冲突？`module-kernel` §3 已声明「单测用真实 alysia 模块形状做 fixture」
      —— 本 change 是它的**落实**（P1 只覆盖了 kernel 自身，没覆盖模块）
- [x] 涉及 Web API？不涉及

## 测试计划

- 新增 28 用例（4 文件）全绿
- 回归：常规全仓 + 全部 E2E（真 API）
- 两个包 `tsc --noEmit` 退出码 0

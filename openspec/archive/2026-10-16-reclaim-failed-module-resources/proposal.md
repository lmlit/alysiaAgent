# Change Proposal: reclaim-failed-module-resources

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（修 bug，**行为变更**：失败模块的资源现在会被回收）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `module-kernel` §2.3（`start()` 语义 5/6 改写 + 新增第 7 条）
- **来源**: 修复计划「第三批：运行可靠性与安全收口」的「模块回滚」项

## 这条要解决什么

**启动失败时，失败模块自己已创建的资源没有被回收。**

`ModuleHost.installOne()` 把 `ctx.effect()` 的 disposer 收集进一个**局部** `effects` 数组，
但 `this.installed.push({ name, effects })` 只在 **apply 成功之后** 执行
（`host.ts` 的 try/catch 之后那一行）。于是：

- 模块 `apply` 到一半抛错（例如先起了个 `setInterval`、挂了个监听，然后炸）；
- catch 里**直接** `throw`（critical）或 `registerDegraded` + return（`critical:false`）；
- 那条 `installed` 记录**从来没进去过** ⇒ `rollback()` 只弹登记表，**收不到它**。

**后果**：一个「半启动」的模块继续在后台跑 —— 定时器还在滴、监听还挂着，
而这个模块在宿主看来**要么"启动失败"（critical）、要么"降级为 undefined"（critical:false）**，
**没有任何机制会再回收它们**（`stop()` 也只遍历 `installed`）。
这正是本仓 KI-6（`core.stop()` 不释放资源）的同一类问题在**启动失败路径**上的翻版。

## 需求（做什么）

- [ ] **R1**：`critical: true` 模块 `apply` 抛错 → **先逆序回收它自己已注册的 effect**，再中止整树
- [ ] **R2**：`critical: false` 模块 `apply` 抛错 → 同样**先回收它自己的 effect**，
      然后走既有的 `registerDegraded` + 继续装后续模块
- [ ] **R3**：回收顺序与 `stop()` 一致（**后注册的先清理**，async 全部 await，
      单个 disposer 抛错不中断其他）
- [ ] **R4**：**不二次回收** —— 已在失败时回收过的 effect，`stop()` / `rollback()` 不得再跑一遍
      （disposer 不保证幂等）
- [ ] **R5**：回收本身**必须留痕**（回收了几项），不静默
- [ ] **R6**：`apply` **正常返回**的模块**不受影响** —— 不在启动时就把它卸掉

## 设计决策（怎么做，含备选与取舍）

### D1 复用既有 `disposeEntry()`，不新写一套清理逻辑

`disposeEntry({ name, effects })` 已经是「逆序、await、单个抛错进 logger.error 不中断」
的标准清理器，`rollback()` 与 `stop()` 都走它。失败路径直接调它，
就自动满足 R3，且**不产生第二套语义**（两套迟早分叉）。

### D2 `critical:false` 失败后，用**空数组**登记，而不是原数组

因为 effects 已在失败时回收过了。若仍把原数组 push 进 `installed`，
`stop()` 会把同一批 disposer **再跑一遍**（R4）。
⇒ 登记 `{ name, effects: [] }`：服务降级语义（`registerDegraded`）保留，资源不重复清理。

**被否决：让 disposer 幂等**——那是把所有 disposer 的正确性责任推给每个模块作者，
而契约应当由宿主保证。**被否决：失败时不回收、只登记**——那就等于回到现状
（半个模块继续跑），正是本 change 要修的东西。

### D3 只动失败路径，不动成功路径与 `stop()`

成功路径的语义（记录进 `installed`、`stop()` 时逆序 dispose）**逐字不变**（R6 有回归用例兜底）。
本 change 的改动面仅限 `installOne` 的 catch 分支。

## 对账方向确认

- [x] 与现有 spec 冲突？——§2.3 的 `start()` 语义 5/6 **只说了**「中止整树 / 登记为 undefined」，
      **从未声明**失败模块自己的 effect 该怎么办。本 change **补契约**（新增第 7 条），
      并把 5/6 改写为「先回收自己的 effect，再走原路径」。
- [x] 方向判断：这是**缺陷**（行为不对，与 doc 无关），非 doc/impl gap ⇒ **改 impl + 补 doc**。
- [x] 涉及 Web API？——**不涉及**，纯内核行为。

## 测试计划

落点：`packages/core/tests/kernel/host.test.ts`（复用既有的 `makeTrace` / `newHost` 夹具）。

| 编号 | 场景 | 验收 |
|---|---|---|
| M1 | critical 模块「先注册 2 个 effect、再抛错」 | 两个 effect **都被回收**（旧实现一个都不回收） |
| M2 | 同上，检查顺序 | 回收是**逆序**（后注册的先清理） |
| M3 | `critical:false` 同类模块 | effect 被回收，且 `stop()` **不二次清理**；依赖方仍拿到 `undefined` |
| M4 | `apply` 正常返回的模块 | 启动时**不**被卸；`stop()` 时才清理（回归） |
| M5 | 回归 | 既有的「critical 失败 → 中止整树 + 逆序回滚」「critical:false → 降级」用例继续通过 |

## ⚠️ 动手前的提醒

- **别把失败模块的服务登记也一起删了**：`registerDegraded` 是 `critical:false` 的**降级语义**
  （LanceDB 失败 → `vectorStore = null` → 文本检索兜底），回收的是**资源**，不是**服务声明**。
- **别顺手改成功路径**：本 change 的风险面就是 catch 分支；扩到成功路径会需要重跑全部内核用例。

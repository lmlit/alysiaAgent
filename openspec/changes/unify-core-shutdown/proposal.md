# Change Proposal: unify-core-shutdown

## 元信息

- **日期**: 2026-10-02（**已定名已久，首次落成 change 文件**）
- **类型**: MODIFY（停机清理）
- **状态**: pending（**登记在案**）
- **影响 spec**: `module-kernel`（§5.1 的停机面）、`memory-system`（§4.7 存储留痕契约的收尾）
- **来源**：`docs/KNOWN-ISSUES.md` **KI-6**；`modularize-core-assembly` proposal **决策 2** 预留

## 这条要解决什么

`core.stop()` **只停 EventBus**，不关闭 SQLite 句柄，也不释放 LanceDB 目录。

**后果**：Windows 上临时目录删不掉（`EPERM`）——
`packages/core/tests/memory/e2e/core-turn.test.ts` 的 `afterAll` 里就带着这条实测注释。
**"优雅停机"名不副实。**

## 为什么当时没做（不是遗漏，是刻意的）

`modularize-core-assembly`（P1 模块化）的**自我约束是「行为逐位不变」**，
而关 DB 句柄**是行为变更**（会引入"关太早导致后续写入报错"的新失败模式）。
所以当时明确把它推给独立 change —— 本文件就是那个 change 落地的地方。

证据：`packages/core/src/modules/loop.ts` 的 `bootModule` 只注册了 `eventBus.stop()`。

## 需求（做什么）

- [ ] 给 `al:db` / `al:vector` 模块（`packages/core/src/modules/`）加停机 effect：
      `db.close()` / LanceDB 目录释放
- [ ] **明确停机顺序**：谁先关？（EventBus 停了之后还有没有在飞的写入？）
      —— 这是本 change 真正的难点，**先读代码确认，别凭直觉**
- [ ] 处理"关太早"的新失败模式：停机过程中到达的写入应当**明确失败**（而不是静默丢弃）
- [ ] 更新 `module-kernel` §5.1（现有"刻意不做"表里那条 → 改为已兑现）
- [ ] E2E 的 `afterAll` 去掉 `EPERM` 变通注释（能真删掉临时目录 = 验收）

## 对账方向

- doc 已声明（§5.1 明确写了"这是行为变更，归独立 change"）→ **改 impl**，不改 doc。

## ⚠️ 动手前的提醒

- **它是行为变更**：`stop()` 之后任何写入都会从"静默成功"变成"抛错"——
  要确认没有"停机后仍会写"的路径（cron / 定时器 / 在飞的 LLM 回调）
- **别只看测试过不过**：测试里 `stop()` 之后就没有写入了，**测不出生产里的停机竞态**
- 与 **KI-16**（`PersonaStore` 读时回写）有交互：若读操作会自动写 DB，
  停机后一次"读"就可能触发一次写入失败

# Tasks: reclaim-failed-module-resources

> 单一项的小 change。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/kernel/host.test.ts`
      新增 describe「★ 失败模块自身的资源回收（第三批）」
- [x] 复现确认**红**：
      `失败模块自己注册的资源泄漏了（定时器/监听会在后台继续跑）:
       expected [ 'install:al:db', …(2) ] to include 'dispose:al:half#1'`
      —— 3 failed / 18 passed
- [x] `installOne()` 的 catch 分支：**先** `disposeEntry({ name, effects })` 回收失败模块自己的资源
- [x] 回收后打 `logger.warn`（回收了几项）—— R5 不静默
- [x] `critical: true`：回收后照旧 `throw`（中止整树 → 外层 `rollback()` 收其余）
- [x] `critical: false`：回收 → `registerDegraded` → **用空数组登记**（避免二次清理）→ 继续
- [x] 未新写清理逻辑：复用既有 `disposeEntry()`（逆序 / await / 单个抛错不中断）

## 测试

- [x] M1 主症：critical 模块到一半抛错 → 它注册的 2 个 effect **都被回收**
- [x] M2 顺序：逆序回收（`dispose:al:half#2` 先于 `#1`）
- [x] M3 `critical:false` 半途失败 → 资源被回收；`stop()` **不二次清理**；依赖方仍拿 undefined
      （由既有的「critical:false 降级」用例继续守）
- [x] M4 回归：`apply` 正常返回的模块启动时**不**被卸，`stop()` 时才清理
- [x] M5 回归：既有 3 条失败策略用例（中止整树 / 降级 / 记 error）继续通过

## Apply 任务

- [x] A.1 合并到 `openspec/specs/module-kernel/spec.md` §2.3：改写 `start()` 语义 5/6 + 新增第 7 条
- [x] A.2 更新 `openspec/specs/index.md`（module-kernel 行的「最后变更」）
- [x] A.3 运行测试（命令与结果见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| kernel 定向 | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run tests/kernel`（`packages/core`） | **2 files / 36 passed** |
| core 全套 | 同上接 `run --exclude='tests/memory/e2e/*'` | **73 files / 709 passed**（本 change 前 705，+4） |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

**行为变更披露**：

1. 启动时若某模块 `apply` 半途抛错，它已注册的 effect **现在会被执行**（此前从不执行）。
   对生产代码的直接收益：`al:vector` 之类决定时失败不再留下孤儿定时器/监听。
2. `critical:false` 失败模块在失败瞬间就被停掉（此前它可能**继续跑**到 `stop()`，
   而 `stop()` 在当时也收不到它 —— 那条记录压根没进 `installed`）。
   ⚠️ 这意味着：**依赖「失败模块仍继续工作」的假设不再成立**——
   但那种依赖本身就是缺陷（模块都 `apply` 失败了）。

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据。
本 change 与同批次其余项一并等待发版。

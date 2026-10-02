# Tasks: add-module-kernel

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> **本 change 零侵入**：不修改任何现有文件。

## 实现任务

### 契约

- [x] `packages/core/src/kernel/types.ts`（新）：`Module` / `ModuleContext` / `ModuleHostOptions` 类型
      - `Module.name` / `inject?` / `provides?` / `peer?` / `critical?` / `Config?` / `apply(ctx, config?)`
      - `ModuleContext.get/provide/effect/on/emit/logger/config`
      - ★ **`provides` 是 propose 后新增的**：`inject` 的提前校验与重复检测需要静态声明，
        不能等 `apply` 跑起来才知道谁提供什么。`false` = 纯副作用模块
- [x] `packages/core/src/kernel/host.ts`（新）：`ModuleHost` 类
      - `use(module, config?)` 登记；**同名模块 / 重复服务名声明在 `use()` 就抛错**
      - `start()`：静态校验 → 拓扑排序 → 逐个 install；`inject` 未满足 → **install 前** throw
      - `stop()`：**逆序** dispose，含 effect 收集到的清理器；幂等
      - 循环依赖检测 → throw 并报出**完整环路径**
- [x] `packages/core/src/kernel/context.ts`（新）：`ModuleContext` 实现
      - `provide` 同名冲突 → throw；**未声明就 provide → throw**（防拼写错误）
      - `effect(setup)`：收集 disposer；`stop()` 后调用 → throw（对应 cordis `INACTIVE_EFFECT`）
      - `on/emit`：最小事件总线（模块间通信，非 pipeline 的 EventBus）
      - `emit` 时单个 handler 抛错不中断其他，进 error 日志
- [x] `packages/core/src/kernel/index.ts`（新）：对外导出

### 关键行为

- [x] **双向依赖策略**：**选定方案 A（`peer` 声明，必须对称）**——互相 peer 的模块合并为
      同一安装单元，单元内按声明顺序 install 且 **inject 不校验**（→ 必须延迟接线）
      - 实测 fixture：`al:coalescer ↔ al:eventbus` 用 `ctx.on/emit` 握手，双向接线均生效
      - 被否决：B 合并成一个模块（丢概念边界）、C 延迟解析全部 inject（牺牲 fail-fast）

### 单测

- [x] `packages/core/tests/kernel/host.test.ts`（新，19 用例）
- [x] `packages/core/tests/kernel/context.test.ts`（新，15 用例）
- [x] `packages/core/tests/kernel/fixtures.ts`（新）：alysia 真实模块形状
      （`al:db → al:memory` 依赖链、`al:vector` 失败降级、`al:coalescer ↔ al:eventbus` 成环）

### ★ 实现中途单测抓出的真 bug

- [x] **critical 模块失败回滚后，服务表没清空**——宿主会报告一个已被卸载的幽灵服务，
      依赖方拿到它却在用已 dispose 的资源。修法：抽出 `clearRegistries()`，
      启动失败回滚与 `stop()` 共用（`host.ts`）

### 文档

- [x] `packages/core/src/kernel/README.md`：契约速查 + 与 cordis 的对应表 + peer 的代价

## 不做（后续 change）

- [x] ~~改写 `AlysiaCore.start()`~~ → `modularize-core-assembly`（P1）
- [x] ~~迁移现有模块到 `modules/`~~ → P2/P3
- [x] ~~提示词资产外置~~ → P4
- [x] ~~配置 schema 校验~~ → 二期映射 cordis Standard Schema 时补
- [x] ~~HMR / 热重载~~ → 不做（dsh 有，我们不需要）

## Apply 任务

- [x] 新建 `openspec/specs/module-kernel/spec.md`（canonical）
- [x] 更新 `openspec/specs/index.md`（新增 `module-kernel` 行）
- [x] `openspec/specs/alysia-architecture/spec.md` §2.2 补指向 `module-kernel`
      （原文「预留细粒度拆分扩展点」→ 指明扩展点在哪）
- [ ] 更新 `docs/HANDOFF.md`（下一步指向 P1）
- [x] change 的 `spec.md` 标注「草案已过时 + 4 处差异」，避免与 canonical 漂移

## 验收结果（2026-10-01）

| 项 | 标准 | 实测 |
|---|---|---|
| 新增测试 | 全绿 | ✅ **34 passed**（host 19 + context 15） |
| 现有测试 | **715 全绿，一个不差** | ✅ core 557（+34）+ server 192 = **749** |
| 现有**代码**文件改动 | **0 个** | ✅ 只有 3 个治理/文档文件按 apply 要求更新（`HANDOFF.md` / `specs/index.md` / `alysia-architecture/spec.md`），**无任何 .ts 被改** |
| 类型检查 | 无错 | ✅ `tsc --noEmit` 退出码 0 |
| 双向依赖 | 有明确行为且被测试锁定 | ✅ peer 单元 + 延迟接线，3 个用例覆盖 |

**环境提醒**：跑测试须把 PATH 里的 node 换成 `E:\nodejs24\node`（v24.19.0），
否则 better-sqlite3 ABI 不匹配，看起来像满屏代码 bug。

## 遗留

- **`peer` 单元内的顺序完全由声明顺序决定**，宿主不做单元内拓扑。
  若将来出现 3 个以上互相 peer 的模块，需要重新审视这个决定。
- 内核尚未接入任何调用方（P1 才接入），**当前是"孤儿代码"**——
  这是决策 5 的刻意结果：让 P0 的验收不受现有 715 影响。

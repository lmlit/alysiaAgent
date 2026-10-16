# Tasks: fix-memory-context-ordering

> 单一项的小 change。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/dsh-adapter/tests/index.test.ts`
      新增 describe「★ 缓存乱序：预热不得覆盖话题刷新（第三批）」
- [x] 复现确认**红**：
      `预热晚归覆盖了更新的刷新结果 —— 这一轮她看到的记忆比上一轮还旧:
       expected '过期的预热内容\n\n（以上是自动带上的记忆概览…' to contain '话题刷新内容'`
      —— 1 failed / 35 passed
- [x] `issuedSeq` / `appliedSeq` 两个计数器：**发起时**领号，**落地时**比号
- [x] `setMemoryContext(raw, seq)`：`seq < appliedSeq` → **丢弃**（乱序晚归的旧结果）
- [x] `refreshMemory` 在 `await` **之前**领号
- [x] 预热在 `void sharedPrewarm(...)` **之前**领号（不是 `.then()` 里）
- [x] 空结果**不推进** `appliedSeq`（保持「失败保留旧值」的既有语义）
- [x] 未新增并发原语：只改这一个写入口 + 两个调用点

## 测试

- [x] C1 主症：刷新先落地 → 预热后落地 → context 仍是话题刷新内容、**不含**预热内容
- [x] C2 回归：预热先落地 → 刷新后落地 → 刷新照常覆盖（正常顺序不受影响）
- [x] C3 回归：既有 4 条记忆 context 用例（挂载预热 / 原话刷新 / 失败保留旧值 / `bridge:false`）继续通过

## Apply 任务

- [x] A.1 合并到 `openspec/specs/dsh-adapter/spec.md` §2.2（新增乱序契约）
- [x] A.2 更新 `openspec/specs/index.md`（dsh-adapter 行「最后变更」）
- [x] A.3 运行测试（命令与结果见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| dsh-adapter 全套 | `npx vitest run`（`packages/dsh-adapter`） | **6 files / 102 passed**（本 change 前 100，+2） |
| 类型 | `npx tsc --noEmit`（`packages/dsh-adapter`） | exit 0 |
| core（无依赖关系，仍跑） | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | 73 files / 709 passed |
| server（无依赖关系，仍跑） | `npx vitest run`（`packages/server`） | 13 files / 227 passed |

**行为变更披露**：乱序晚归的**旧**检索结果现在被**丢弃**（此前它会覆盖新结果）。
正常顺序下行为**完全不变**；只有"更早发起的结果更晚返回"时才丢弃。

## 部署状态

**未部署。** 只改代码与契约；未构建/未发布插件包、未重启 dsh、未碰线上数据。
⚠️ 注意：dsh 侧改动要生效需**重新安装插件 bundle**（见 `dsh-adapter` §5 的
`install_bundle` 机制），与 server 的发版是两件事。

# Tasks: fix-llm-request-cancellation

> 单一项的小 change（两个缺陷同一处代码）。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/provider/openai.test.ts` 新增 3 条
- [x] 复现确认**红** —— ★ 用 `git stash push -- packages/core/src/provider/openai.ts`
      把修复**单独暂存**、在**旧代码**上跑，得到下面的原始失败（不是"看着像会红"）：
      ```
      × 超时后**必须 abort 底层请求**（否则连接不释放、后端继续跑）
        AssertionError: 超时后没有 abort 底层请求 —— 连接与后端生成都还在跑:
          expected false to be true
      × 外部 signal 上的监听必须在请求结束后摘掉（长会话下不然会只增不减）
        AssertionError: 每次请求都在长寿命 signal 上残留了一个监听: expected 5 to be +0
      × 回归：外部打断仍然生效（摘监听不能把打断功能也摘掉）
        AssertionError: 请求结束后外部 abort 不该再影响那次已完成的请求: expected true to be false
      3 failed | 9 passed (12)
      ```
      ★ `expected 5 to be +0` 是**监听泄漏的直接证据**：5 次请求 → 5 个残留监听。
      验证后 `git stash pop` 恢复，同一组用例转绿。
- [x] 新增模块级 `linkAbort(reqSignal, controller): () => void`，**非流式与流式共用**
- [x] `textChat`：超时处理器里加 `controller.abort()`（**保留** `Promise.race`）
- [x] `textChatStream`：`raceTimeout` 的超时分支加 `controller.abort()`（同上保留 race）
- [x] 两条路径的 `finally` 都调用 `unlinkAbort()`（覆盖成功/API 错误/超时/打断**全部出口**）
- [x] 未引入 `AbortSignal.any()` / `AbortSignal.timeout()`（理由见 proposal D3：
      会绕开 8-12 的 race 结论，把 566s 那个坑重新挖开）

## 测试

- [x] A1 主症：fetch 永久挂起 → 过 60s → 返回 timed out **且底层 signal 已 aborted**
- [x] A2 主症：同一长寿命 signal 跑 5 次 → 监听数回到请求前
- [x] A3 回归：请求结束后外部 abort 不影响那次已完成的请求
- [x] A4 回归：请求进行中外部 abort 照旧返回 `Request aborted`（既有用例）
- [x] A5 回归：既有 provider 用例继续通过

## Apply 任务

- [x] A.1 合并到 `openspec/specs/alysia-architecture/spec.md` §6.1.1 + §6.1.2
- [x] A.2 更新 `openspec/specs/index.md`（alysia-architecture 行「最后变更」）
- [x] A.3 运行测试（命令与结果见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| provider 定向 | `run tests/provider`（`packages/core`） | **5 files / 40 passed**（本 change 前 37，+3） |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | 73 files / 709 passed |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

**行为变更披露**：

1. 60s 超时时现在会 **abort 底层请求** —— 服务端会更早停止生成、socket 更早释放。
   对调用方可见的语义**不变**（仍然返回 `Request timed out (60s)`）。
2. 请求结束后外部 signal 上**不再残留监听** —— 若某个调用方**依赖**"请求结束后
   还能被外部 abort 回调触发"，那个依赖现在失效；但它是**缺陷性依赖**
   （请求已结束，再打断没有意义），且会让监听无限增长。

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据。

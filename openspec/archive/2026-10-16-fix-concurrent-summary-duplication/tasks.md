# Tasks: fix-concurrent-summary-duplication

> KI-19 残余。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`tests/memory/concurrent-summary.test.ts`
- [x] 复现确认**红**（走 `MemoryManager`，走生产路径）：
      ```
      × ★★ 两次并发结算 → 只留一条 conversation，且不抛
        AssertionError: 并发结算抛错了 —— 旧实现会撞
          `UNIQUE constraint failed: conversations.id`，把后一次整段丢掉:
          expected [ Array(1) ] to deeply equal []
      1 failed | 2 passed (3)
      ```
      ★ 拒斥的那一条就是 PK 崩溃本身 —— 证明这不是"理论上的并发问题"。
- [x] `SessionEndProcessor` 加 `private inFlight = new Set<string>()`
- [x] `process()` 拆成"互斥外壳 + `processInner()`"，互斥在 **`finally` 里释放**（R4）
- [x] 命中互斥 → `{ summarized: false, reason: 'in-flight' }`；
      `SessionEndResult.reason` 联合加 `'in-flight'`；`warnThrottled` 留痕
- [x] `conversations.id` 加 `randomUUID().slice(0,8)` 后缀（保留时间戳便于排查）
- [x] 注释里写明**为什么不能只改 id**（撞 PK 歪打正着挡住了重复摘要）

### ⚠️ 过程中自己抓到的两处测试错误（都值得记）

1. **第一版直接调 `SessionEndProcessor.process(SID)` 不传 `since`** ⇒
   落回"缺省全历史"语义 ⇒ 测出来的"重复摘要"是**测试自己绕过了锚点**。
   ⇒ 改为走 `MemoryManager`（生产路径），复现出的才是真的 PK 崩溃。
2. **第一版用 `vi.useFakeTimers()` 冻结时间** ⇒ 把 LLM mock 里的 `setTimeout(0)`
   一起冻住，测试要 5 秒才走完。
   ⇒ 改为 `vi.spyOn(Date, 'now')` **只冻结时钟读数**，真实定时器照常。

## 测试

3 例全过（见 proposal 的 S1–S3 表）。

## Apply 任务

- [x] A.1 合并到 `openspec/specs/memory-system/spec.md` §5.4.1 **新增契约 4d**
- [x] A.2 更新 `openspec/specs/index.md`（memory-system 行）
- [x] A.3 更新 `docs/KNOWN-ISSUES.md` KI-19 标注（残余已修）
- [x] A.4 运行测试（见下）
- [x] A.5 归档

## 验证记录

| 项 | 命令（workdir `packages/core`） | 结果 |
|---|---|---|
| 定向 | `run tests/memory/concurrent-summary.test.ts` | **3 passed** |
| core 全套 | `run --exclude='tests/memory/e2e/*'` | **81 files / 777 passed**（含本 change +3） |
| 类型 | `npx tsc --noEmit` | exit 0 |

## 部署状态

**未部署。** 只改 core 代码与 spec。

# Change Proposal: server-reliability-fixes

## 元信息

- **日期**: 2026-08-08
- **类型**: MODIFY（缺陷修复）
- **状态**: in-progress（用户确认实施）
- **影响 spec**: reminder-tool（§2 工具定义 / §3 推送链路）+ server-hardening（新增章节）

## 动机（为什么做）

8-08 服务端优化盘点，用户确认实施三项可靠性修复：

1. **Reminder 三个缺陷**（reminder.ts）：
   - `setTimeout` delay 超过 **2^31-1ms（≈24.8 天）立即触发**——`"600h"` 这类长提醒
     当天就被触发（Node 行为：超限 delay 按 1ms 处理）
   - 定时器回调 `await notifyFn()` **无 try/catch**——sendProactive throw 时 unhandled
     rejection；且**无条件 splice**，推送失败提醒直接丢（用户收到 0 条且无法重试）
2. **bootstrap .env 手写解析**：`resolve(process.cwd(), '..', '..', '.env')` 依赖启动
   CWD，换目录启动加载失败；手写解析不处理引号/转义。替换为 dotenv（默认不覆盖
   已存在变量，与现有 `if (!process.env[key])` 语义一致；文件不存在静默跳过）
3. **cron 无防重叠**（bootstrap.ts）：`setInterval` 每 6h 跑 `memoryManager.cron()`
   （含 LLM 深度画像重写），单次执行超 6h 时并发重入

## 需求（做什么）

- [x] reminder.ts：`delay > 2_147_483_647` 拒绝并报错；定时器回调 try/catch；
      推送失败（throw **或 notifyFn 返回 false**）→ 5min 后重试一次，再失败丢弃并 warn
- [x] bootstrap.ts notifyFn：返回 `ok`（boolean）——sendProactive 结果回传 reminder 判定
- [x] bootstrap.ts：.env 解析换 dotenv（server 新增依赖）
- [x] bootstrap.ts：cron 加 in-flight 锁（`cronRunning` 标志，重叠时跳过）
- [ ] 加测试：reminder 超长拒绝 / 失败重试一次 / 重试后丢弃（fake timers）

## 设计决策

- 推送失败重试间隔 5min、上限 1 次（对齐问候 10min/2 次预算的风格，但提醒是用户显式
  要求，失败影响更直接——重试一次兜底瞬时故障即可，不无限重试）
- notifyFn 语义升级为 `Promise<boolean>`：true=已处理（含非私聊打日志路径），false=需重试
- dotenv 版本跟随 pnpm 解析（v17.x）

## 对账方向确认

- [x] 无 spec 冲突——本 change 是对既有行为的缺陷修复（spec 随 change 更新 reminder-tool §2
      错误处理 + server-hardening 新增"运行时可靠性"章节）

## 测试计划

- reminder.test.ts（新建）：超长 delay 拒绝 / 到点触发调用 notifyFn / notifyFn 返回 false
  重试一次 / 两次失败丢弃不再调用 / cancel 后不触发（vitest fake timers + 微任务 flush）

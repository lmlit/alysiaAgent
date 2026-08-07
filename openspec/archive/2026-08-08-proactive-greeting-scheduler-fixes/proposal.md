# Change Proposal: proactive-greeting-scheduler-fixes

## 元信息

- **日期**: 2026-08-08
- **类型**: FIX（CR 发现，修复 proactive-greeting-context 引入的调度器缺陷）
- **状态**: archived（2026-08-08 归档）
- **影响 spec**: proactive-messages（§2.1.6 问候调度）

## 动机（为什么做）

对 04ef9d2（proactive-greeting-context）做 10 角度代码评审，确认 7 项缺陷：

| # | 级别 | 问题 | 后果 |
|---|------|------|------|
| 1 | P0 | scheduleNextGreeting 的 `next.hour <= now.getHours()` bump 条件对**今天未来候选**误伤 | 12:00-12:29 / 21:00-21:29 重启 → 当天午安/晚安被排到明天，永久丢失 |
| 2 | P1 | 5s 调度余量死区 | 8:59:57 启动 → 早安丢（catch-up 需 hour 匹配、候选需 >5s，都不满足） |
| 3 | P1 | fireGreeting 异常路径不增加重试计数 | catch → scheduleNextGreeting → catch-up 立即重触发 → 无限热循环（sendProactive 可 throw：qq-official.ts:646 uploadImage 在 try 外） |
| 4 | P1 | stop() 后 in-flight fireGreeting 完成 → re-arm timer | 停止的服务继续发问候；最长 24h timer 保持 Node event loop，进程挂住 |
| 5 | P2 | dedup 非原子 | sendProactive 挂 >10min 时重试 timer 触发 → 双发 |
| 6 | P2 | fireGreeting 无窗口守卫 | sleep/时钟变更后延迟 timer 跨天触发 → 发错日期问候并标记错日 key |
| 7 | P2 | 测试 afterEach 缺失 | 断言失败时冻结时间泄漏给后续用例 |

## 需求（做什么）

- [ ] scheduleNextGreeting 重写为**单遍扫描**（DAILY_GREETINGS 时间升序）：
      窗口期（hour 已到且未发未放弃）→ 立即/短延迟补发；未来候选 → 排到点；否则下一时段；
      全过 → 明天最早。消除 bump 条件 + 5s 死区
- [ ] fireGreeting 开头：stopped 检查 + 窗口守卫（`now.getHours() !== hour` → 跳过重排，防跨天）
      + in-flight 集合防并发双发
- [ ] 提取 `scheduleRetry(hour, minute, key)`：false 路径与异常路径共用重试预算
      （最多 2 次、10min 间隔、达上限保留计数防 catch-up 循环）
- [ ] stop() 置 stopped 标志（scheduleNextGreeting/fireGreeting 开头检查）
- [ ] 测试：getTodayActivity describe 加 afterEach；新增回归用例（12:15 启动排今天 12:30、
      8:59:57 排 9:00、sleep 跨天跳过、异常重试预算、stop 后不发）

## 设计决策

- **窗口守卫只用 hour 检查**（不用 `minutes >= g.minute`）：setTimeout 不提前触发保证到点，
  错过窗口必然伴随小时变化（sleep/时钟后移）；12:30:00.0 边界 minutes=0 会误伤旧式检查
- **放弃后保留 greetingRetries 计数**（≥3）：catch-up 跳过，防"失败→补发→失败"循环；
  次日新 key 自然重置
- **in-flight 集合仅内存**：并发双发窗口极小（sendProactive 挂 >10min），重启丢失可接受

## 对账方向确认

- [x] 与 proactive-messages spec §2.1.6 冲突 → 本 change 是 FIX，spec 补充调度语义描述
- [x] 不涉及 Web API

## 测试计划

- 回归：现有 21 个 proactive 测试全部保持通过
- 新增：P0 跨天回归（12:15 启动 → 今天 12:30）、P1 死区回归（8:59:57 → 排 9:00）、
  sleep 跨天跳过、异常重试预算、stop 后不发
- tsc --noEmit + server 全量测试

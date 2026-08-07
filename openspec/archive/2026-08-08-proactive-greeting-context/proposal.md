# Change Proposal: proactive-greeting-context

## 元信息

- **日期**: 2026-08-08
- **类型**: MODIFY（主动消息问候优化包）
- **状态**: archived（2026-08-08 归档）
- **影响 spec**: proactive-messages（时段问候）、qq-reconnect-backoff（已知行为补充）

## 动机（为什么做）

2026-08-08 云端日志分析（8-07 全天）发现：

1. **问候无上下文**（用户提出）：personalize 的 LLM 上下文只有"现在是早上，给用户发一条早安问候"，
   无用户近况、无 AI 今天的生活事件、无亲密度。对比 LifeService woke prompt 全套素材，
   问候生成的是通用模板级文案（实测 8-07 立秋祝福：无个性化素材的套话）。
2. **问候时效差**：tick 每 30 分钟，9:00 的早安 **09:29:33 才发**、12:30 午安 12:59:34、21:30 晚安 21:59:34。
3. **日志前缀不一致**：发送日志 `Proactive greeting 9:0: sent` 无 `[Proactive]` 前缀
   （启动/加载有），grep `[Proactive]` 漏掉全部发送记录，误导排查（实测被误导）。

## 需求（做什么）

- [ ] 问候上下文注入：personalize 上下文加用户近况（getUserActivitySummary）+ 今天生活事件
      （listLifeEvents 当天最新 3 条）+ 亲密度（getLifeSnapshot.intimacy），注明"不要生硬引用"
- [ ] 精确到点调度：问候改独立调度器（到点 hour:minute 触发），不再依赖 30min tick；
      tick 移除问候循环防双发；支持重启补发（当前时刻处于未发问候窗口期 → 立即发）+ 失败重试
      （同 key 最多 2 次、间隔 10min）
- [ ] 日志前缀统一：`[Proactive] greeting 9:0: sent` / `[Proactive] festival "立秋": sent` /
      `[Proactive] care → xxxx: sent`
- [ ] 测试：调度器（到点触发/补发/去重）、上下文注入（素材存在时 prompt 含素材）
- [ ] qq-reconnect-backoff spec 补"平台 30 分钟强制重连"已知行为（8-06/8-07 实测每天 47 次 op:7）

## 设计决策

- **调度器结构**：`scheduleNextGreeting()` 计算下一次问候时间 → setTimeout 到点 `fireGreeting(hour, minute)`
  → 发送完成（成功/失败/重试用尽）后递归排下一次。问候从 tick() 循环移除，tick 只留节日 + 关怀。
- **重启补发**：scheduleNextGreeting 时若当前处于某问候窗口内（hour===g.hour && minutes>=g.minute）且
  未发送 → 立即补发。保持旧 tick 逻辑"重启后 9:xx 能补发 9:00 问候"的行为。
- **重试**：发送失败（sendProactive false）时 10min 后重试，同 key 最多 2 次，防 API 抖动丢问候；
  重试计数仅内存（重启后由补发逻辑兜底）。
- **上下文素材**：全部 try/catch 静默失败（素材缺失不阻塞问候）；明确提示 LLM
  "用于让问候更自然贴切，不要生硬引用"防贴标签式文案。

## 对账方向确认

- [x] 与 proactive-messages spec 冲突 → 本 change 是 MODIFY，apply 时更新 spec §2
- [x] 不涉及 Web API（无新增 core 方法，全部复用 LifeService 已有接口）

## 测试计划

- 新增 proactive.test.ts 用例：scheduleNextGreeting 到点计算、fireGreeting 发送+去重、
  窗口期补发、失败重试上限、contextSnippet 素材注入
- tsc --noEmit 类型检查
- 云端部署后日志验证：9:00:00 左右发送、日志带 [Proactive] 前缀、问候文案含生活素材

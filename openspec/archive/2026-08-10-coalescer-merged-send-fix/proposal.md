# Change Proposal: coalescer-merged-send-fix

## 元信息

- **日期**: 2026-08-10
- **类型**: FIX（合并事件缺 send 回调 → 合并回复静默丢失）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.5 输入合并 + 打断）

## 动机（为什么做）

线上实测（22:27 日志）：合并生效后，合并事件生成回复（18805ms）但
【没有发送】——`[LLMAgent] →` 日志后无 `Sending reply`、无错误日志。

根因链：
1. Coalescer 创建的合并事件（`new MessageEventClass({...})` 只传 4 字段）
   **未继承 adapter 挂的 `event.send` 回调**——而 `MessageEvent.send` 默认
   实现直接 throw `'send() must be overridden by Platform adapter'`
2. RespondStage 调 `event.send` → throw → **`catch {}` 静默吞掉** → 回复
   丢失且无任何日志
3. 顺带噪音：manager 在 abort 导致的 err 时打 `[Provider] default failed,
   trying next...` WARN（abort 检查在循环开头，err 后先打 WARN 才检查）

## 需求（做什么）

1. **合并事件继承 send**：`mergedEvent.send = base.send`（adapter 的回调闭包
   捕获原消息 data/msg_id，不依赖 this，直接复制即可）
2. **RespondStage 不静默**：send 失败打 `logger.error`（丢回复必须有日志）
3. **manager abort 不误报**：provider err 响应后、打 WARN 前检查
   `req.signal?.aborted` → 直接 return（abort 导致的 err 不算 provider 失败）

## 设计决策

- `event.send` 是实例字段（adapter 在事件构造后赋值 `event.send = async...`），
  直接赋值复制回调安全（闭包不依赖 this）
- 合并事件沿用原消息 msg_id 被动回复：QQ 被动回复配额 5 分钟有效，
  合并生成通常几秒到几十秒，窗口内有效

## 对账方向确认

- [x] 已归档 change 的实现缺陷 → 本 change 记录并修订

## 测试计划

- Coalescer：flush 后合并事件 `send === base.send`（回调继承）
- RespondStage：send 失败 → logger.error 被调用（不再静默）
- manager：abort 导致的 err → 不调 logger.warn、不试 fallback provider
- 既有 289 测试回归

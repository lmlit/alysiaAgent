# Change Proposal: coalescer-cancel-thinking

## 元信息

- **日期**: 2026-08-10
- **类型**: FIX（合并时冗余"思考中"提示）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.5 输入合并 + 打断）

## 动机（为什么做）

线上日志（22:43）：长诗 + "哼哼哼" 合并成功、合并回复正常发送，
但用户收到**两条"思考中"提示**。根因：adapter 每条 C2C 消息启动 5 秒
thinkingTimer（qq-official.ts:469），被打断合并的消息（B）其 pipeline 在
Coalescer 直接 return，adapter 不知情 → B 的 timer 照常 fire → 冗余提示
（回复已由合并事件统一生成）。

## 需求（做什么）

1. **adapter 注册取消回调**：`event.setExtra('cancel_thinking', () => { clearTimeout(timer); })`
2. **Coalescer 打断入桶时取消入桶事件**（B）的 timer——B 已合并，不再单独提示
3. **保留在途事件**（A）的 timer——合并回复确实在途，"思考中"提示语义正确；
   回复发送时 base.send 闭包本就 clearTimeout(A)
4. flush 兜底路径（capTimer）统一取消桶内全部事件的 timer（防漏）

## 设计决策

- core 不感知 adapter 细节：回调经事件 extra 传递（`cancel_thinking`），
  adapter 实现、Coalescer 调用——松耦合
- 只取消入桶事件：在途事件（A）的提示保留（合并回复等待 >5s 时有反馈）

## 对账方向确认

- [x] 已归档 change 的交互缺陷 → 本 change 记录并修订

## 测试计划

- Coalescer：打断入桶时调用新事件的 cancel_thinking；flush 时桶内事件全部调用；
  在途事件（被打断基底）的 cancel_thinking 不被调用
- 既有 293 测试回归

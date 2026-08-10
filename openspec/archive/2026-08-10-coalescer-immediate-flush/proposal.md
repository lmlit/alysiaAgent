# Change Proposal: coalescer-immediate-flush

## 元信息

- **日期**: 2026-08-10
- **类型**: MODIFY（修订 input-coalescing-and-abort 的窗口行为）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.5 输入合并 + 打断）

## 动机（为什么做）

上线后用户反馈：固定 10s debounce 窗口给每条私聊消息都引入了 10s 回复延迟，
与"输入合并"的初衷相悖。窗口不应是准确时间，而应绑定大模型回复时间。

## 需求（做什么）

修订合并窗口行为：

1. **首条消息立即放行**：无窗口延迟，LLM 请求即刻发出（回复已出时新消息也是独立首条）
2. **打断累计**：新消息到达时若该 session 在飞生成（回复未出）→ 打断它，消息入桶累计；
   被打断生成结束（llm-agent aborted 分支回调 `onGenerationAborted`）→ 立即 flush
   合并事件重发（文本 = 被打断事件 + 桶内累计消息，换行拼接）——"没有回复就能累计"，
   生成期间每来一条都打断合并重发，直到回复真正出来
3. **10s 仅作兜底上限**：`maxWaitMs` 防 onGenerationAborted 回调丢失时桶悬挂
   （正常路径由回调即时 flush，不等待）
4. 群聊不合并不打断（不变）；图片预热（不变）；EventLog 忠实（不变）

## 设计决策

- `AbortRegistry.isInFlight(sessionId)`：controller 存在且未 abort = 有在飞请求，
  判定"打断合并" vs "直接放行"
- `CoalescerStage.onGenerationAborted(sessionId, abortedEvent)`：由 llm-agent 在
  aborted 分支回调（fire-and-forget），携带被打断事件文本作为合并基底
- 合并事件重入 pipeline 时若再被新消息打断，其文本继续作为下一轮合并基底
  （累计不丢失）

## 对账方向确认

- [x] 修订已归档 change 的行为 → 本 change 记录修订，spec §3.5 同步更新

## 测试计划

- 首条立即 yield（不等窗口）
- 第二条打断在飞 + 入桶；onGenerationAborted → 合并事件（被打断文本 + 累计消息）
- 回复已出（无在飞）→ 新消息独立放行
- 多轮打断累计（m1+m2+m3）
- maxWait 兜底 flush（回调丢失场景）
- 无累计消息时回调不产生合并事件

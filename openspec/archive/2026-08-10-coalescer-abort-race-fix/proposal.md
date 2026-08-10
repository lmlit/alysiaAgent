# Change Proposal: coalescer-abort-race-fix

## 元信息

- **日期**: 2026-08-10
- **类型**: FIX（修订 coalescer-immediate-flush 的打断竞态）
- **状态**: pending
- **影响 spec**: alysia-architecture（§3.5 输入合并 + 打断 / §6.1.1 abort 契约）

## 动机（为什么做）

上线后发现的竞态：**打断时 LLM 响应可能已经完整返回**（fetch 已 resolve，
runner 正在收尾），此时 runner 的 abort 检查（循环开头 + err 分支）检查不到，
返回正常结果 → 被打断的回复 A 照常发送；同时新消息 B 已入桶但 llm-agent
不调 `onGenerationAborted`（它以为没被打断）→ 桶悬挂 → 10s 兜底 flush
合并 [A+B] 重新生成再发一条 → **双重回复**。

用户拍板语义：**被打断就丢弃（结果永不保留），合并只合并输入请求，
不合并返回结果**。

## 需求（做什么）

1. **runner 返回前终检**：while 循环结束后、组装 chain 返回前，检查
   `signal.aborted` → 已 abort 则返回 aborted 标记（丢弃已产出的文本，
   不进入发送）
2. **llm-agent 双保险**：正常完成路径设 `response_chain` 前，再查
   `abortCtrl.signal.aborted`（防 runner 未来改动引入新漏网路径），命中则
   同样丢弃 + `onGenerationAborted` 即时合并重发
3. 效果不变式：**任一被 abort 的生成，其回复永不发送**；合并事件只含
   输入消息文本（被打断事件文本 + 桶内累计），重新生成统一回复

## 设计决策

- 修复点放在 runner 层（返回前终检）——所有调用方（llm-agent / Life /
  Proactive 等）统一受保护，不限于 coalescer 路径
- llm-agent 的 controller 引用在 abort 后 `signal.aborted` 仍为 true
  （AbortRegistry.abort 只 delete 注册表条目，不重置已发出的 signal）→
  双保险检查有效
- 桶悬挂不再可能：任何 abort 必然走 onGenerationAborted 即时 flush
  （runner 终检捕获 + aborted 分支回调），capTimer 兜底降级为纯防御

## 对账方向确认

- [x] 已归档 change 的竞态缺陷 → 本 change 记录修复，spec §3.5/§6.1.1 同步更新

## 测试计划

- runner：fetch 正常 resolve 但返回前 signal 被 abort → 返回 aborted、
  chain 为空、provider 被调用过一次（请求已发出）
- llm-agent：runner 返回正常结果但 controller 已被 abort → 不设
  response_chain、调用 onGenerationAborted（丢弃 + 合并）
- 既有 coalescer 12 测试 + 全量回归不破坏

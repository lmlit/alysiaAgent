# Change Proposal: cr-p0-session-isolation

## 元信息

- **日期**: 2026-08-29
- **类型**: FIX（修 bug）
- **状态**: proposed
- **影响 spec**: `memory-system`

## 动机（为什么做）

CR 2026-08-29 P0-1：`ConversationStore` 群分支用 `sessionId.split(':group:')[0]` 只取平台前缀，再 `LIKE '平台:group:%'` 匹配——同平台**所有群**的对话摘要都会被捞出来，群 A 的聊天内容注入群 B 的 prompt；private 分支 `LIKE '%:private:%'` 跨平台混入所有私聊摘要。

业务复核降级（P0→P1）：当前 owner 单群使用场景不触发跨群泄漏，且"单人格全局共享记忆"是架构设计；但多群/多私聊扩展时是隐私隐患，且 spec 未将"摘要跨群混合"声明为设计意图。

## 需求（做什么）

- [ ] ConversationStore group 分支按**完整会话前缀**匹配（`平台:group:群ID%`）
- [ ] private 分支按平台前缀限定（`平台:private:%`）
- [ ] 排查 EventStore/其他 Store 的 `getBySession` 类方法是否有同类跨会话串扰

## 设计决策（怎么做，含备选与取舍）

- **保留 `%` 后缀**：`sessionId` 带群 ID，用 `LIKE '平台:group:群ID%'` 精确到群，`%` 兜底会话内子结构——参考实际 sessionId 格式后再定，避免误伤同一群内的多个会话。
- 不改成 `=` 精确匹配，除非确认 sessionId 无子结构。

## 对账方向确认

- [x] spec 未声明跨群摘要共享 → 本 change 按"会话隔离"补约束
- [x] 涉及 Web API？无接口变更

## 测试计划

- 两个群 + 两个平台私聊数据 → 各会话只取到自己的摘要
- 同群内多会话（若有）仍可取到

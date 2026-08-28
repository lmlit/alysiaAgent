# Change Proposal: life-event-message-split

## 元信息
- **日期**: 2026-08-29
- **类型**: MODIFY
- **状态**: archived
- **影响 spec**: `ai-life-system`

## 动机
chat 事件把生活叙述直接推给用户——"起身把杯子放进水槽…夜静得只剩水流声"是自言自语,不是对用户说话。HDSI 分离 script(生活剧本)与 interaction.reply(对用户的话):"思考留在生活里,直到 reply 把它带给用户"。

## 需求
- [ ] 事件 JSON 加 `message` 字段(type=chat 时):对轻月说的话(第二人称/口语/互动感);content 保持生活叙述(入库)
- [ ] 推送:chat && can_contact → sendProactive(message ?? content);无 message 回落 content
- [ ] 回写:content 回写生活(self),message 回写 assistant(推送的才是用户看到的)
- [ ] intent:can_contact=false 时 intent.content 用 message(想对轻月说的话)
- [ ] prompt 引导:type=chat 时 message 是对轻月说话,content 是生活本身
- [ ] post-check:message 存在时校验(第二人称/不引用对话/长度)

## 对账
- [x] spec 事件生成/推送节更新;不涉及 Web API

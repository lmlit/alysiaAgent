# Change Proposal: prompt-context-fixes

## 元信息

- **日期**: 2026-08-09
- **类型**: FIX（prompt 组装 4 缺陷）
- **状态**: in-progress（用户确认全修；8-09 全量 prompt 抓包定位）
- **影响 spec**: memory-system（PromptAssembler/EventStore/ConversationStore）+ server（memory-retrieval 注入）

## 动机（为什么做）

8-09 打开 [LLM] request 全量输入日志，真实 prompt 暴露 4 个缺陷：

1. **人格参数全 undefined**：`语气: 形式度=undefined`——云端 persona 表 tone/speech_style/
   emotional_range 全是 `{}`（历史遗留，`ensureRow` 只 INSERT OR IGNORE 不修已有行），
   PromptAssembler 无空值兜底 → 人格自适应形同虚设 + 白烧 token
2. **画像事实重复**：37 条事实里"长沙"4 条、"法环"3 条、花名 3 条——组装层去重 key
   （去 9 个停用字 + 前 15 字截断）太弱，"用户在长沙"与"用户目前所在城市是长沙"key 不同
3. **群聊摘要混入私聊**：ConversationStore.getRecent(3) 无 session 过滤
   （`ORDER BY started_at DESC LIMIT 3` 全库取）→ 私聊 prompt 带群聊 summary
4. **EventLog 回写角色错乱**：getRecentBySession 把 content 拼 `${sender_name}: ` 前缀
   （sender_name 缺失默认"用户"）→ Life assistant 回写显示"用户: 听到楼下琴声"（LLM
   误以为用户说的）；openid 直接暴露 prompt；role 用 `sender_id` 旧式推断

## 需求（做什么）

- [x] PromptAssembler：人格参数空对象 fallback 默认值（undefined 不再出现）
- [x] PersonaStore.ensureRow：已有行 tone/speech_style/emotional_range 为空/{} → 补默认值
- [x] PromptAssembler 事实去重增强：停用字扩表 + 子串包含合并（短事实并入长事实）
- [x] ConversationStore.getRecent(limit, sessionId?)：按会话类型过滤（private 只取 private，
      group 只取同群）；PromptAssembler/MemoryManager/调用链透传 sessionId
- [x] EventStore.getRecentBySession：content 纯文本（去前缀）、role 用 payload.role 显式
      判断、senderName 独立字段
- [x] memory-retrieval [最近对话]：`[时间] 你/昔涟: 内容`（角色短标签，不暴露 openid）
- [x] 云端数据修复：persona 表空值 UPDATE 默认参数
- [ ] 测试 + spec 合并 + 部署

## 设计决策

- role 判断：`p.role === 'assistant'` 显式优先，兼容旧 payload（无 role → 旧式 sender_id 推断）
- 去重：组装层子串包含合并（去停用字后短者 ⊆ 长者 → 保留长者）；入库层查重不在本轮
  （ProfileExtractor 改动面大，组装层已能消除 prompt 内重复）
- session 过滤语义：private 会话只注入 private 摘要；group 只注入同 group_id 摘要

## 对账方向确认

- [x] memory-system spec（EventLog 读取契约）有行为变更——spec 随 change 更新

# Change Proposal: wire-console-chat

## 元信息

- **日期**: 2026-09-25
- **类型**: MODIFY（把演示页换成真实功能）
- **状态**: in_progress
- **影响 spec**: `alysia-console`（§5 页面契约：`/chat` 移出「未接入」）
- **关联**: `adopt-nextjs-console` 时 `/chat` 整页标注「演示数据」

## 动机（为什么做）

`/chat` 是这套前端的**核心体验**，但收编时它整页是写死的演示（3 条硬编码回复轮播）。
服务端的聊天端点 8-15 就做好了（`webui-chat-endpoints`），webui 也跑通了，
差的只是把 console 接上去。

## 需求（做什么）

- [ ] `lib/api/stream.ts`：SSE 解析（`chunk` / `done` / `aborted` / `error` 帧）
- [ ] `lib/api/modules.ts`：`chatApi.messages(id, limit, before)` / `chatApi.pending(id)`；
      `sessionApi` 补 `archive` / `remove`
- [ ] `components/chat/chat-room.tsx` 重写：真会话列表 + 真历史 + 真流式
- [ ] 流式区分 `kind`：`reasoning` 进「思考条」（可展开），`text` 进正文
- [ ] 停止按钮：**用 `AbortSignal` 真的掐断请求**（见下）
- [ ] 新会话 / 切换会话 / 归档 / 彻底删除 / 重命名
- [ ] 页面顶部的 `DemoBanner` 移除

## 设计决策（怎么做，含备选与取舍）

**决策 1：`AbortController` 必须真的传给 `fetch`**

★ webui 的停止按钮是**坏的**：`ChatView.vue` 建了 `AbortController` 并 `abort()`，
但 `streamChat()` 的 `fetch` 调用**从未接收 signal** —— 网络请求照跑，只是界面把
`streaming` 设成 false 假装停了。console 实现必须把 signal 接上
（`fetch(..., { signal })`，`AbortError` 与真实错误区分处理）。

**决策 2：localStorage 键用 console 自己的，不共用 webui 的**

webui 用 `aw-chat-session` / `aw-chat-names`。console 用 `console-chat-session` /
`console-chat-names`。理由：两个前端并存期若共用，同时开两个页面会互相覆盖当前会话；
且 webui 待废弃，不该让新代码依赖它的键名。

**决策 3：会话 id 用 `sess-<ts>`，服务端首次发消息时才真正建会话**

与 webui 一致——服务端 `/api/chat/stream` 对未知 sessionId 直接接受并在事件流里落库。
不需要"新建会话"接口。

**决策 4：不接表情包渲染**

webui 会把 `[表情包:名字]` 解析成贴图（`GET /api/stickers/file/:name`）。
console 这版先按纯文本显示——表情包渲染是独立的一块，且先把主链路跑通更重要。
**风险**：回复里出现 `[表情包:xxx]` 时会原样显示成文字。若观感问题明显，开后续 change。

## 对账方向确认

- [x] 是否与现有 spec 冲突？无——`alysia-console` §5 把 `/chat` 标为未接入，
      本 change 改为已接入（doc 跟进 impl，非降级）
- [x] 涉及 Web API？**不涉及新端点**，只用既有的
      `/api/chat/stream`、`/api/sessions/:id/messages`、`/api/chat/pending`、
      `/api/sessions/:id/archive`、`DELETE /api/sessions/:id`

## 测试计划

- `lib/api/stream.ts` 单测：正常帧序列、分片边界（一个 `data:` 跨两个 chunk）、
  畸形 JSON 跳过、`done`/`aborted`/`error` 收尾、**abort 后不再回调**
- 适配：消息历史倒序 → 正序
- 端到端（无头 Edge）：真发一条消息，`--dump-dom` 确认用户气泡 + 回复渲染、
  页面无「演示数据」、刷新后历史还在

# Tasks: wire-console-chat

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `lib/api/stream.ts`：SSE 解析 + `StreamAbortedError` + **`AbortSignal` 真的接进 fetch**
- [x] `lib/api/types.ts`：`SessionMessage` / `MessagesResponse` / `PendingResponse` / `ChatFrame`
- [x] `lib/api/modules.ts`：`chatApi.messages/pending`、`sessionApi.archive/remove`
- [x] `components/chat/chat-room.tsx` 重写：真会话列表 + 历史 + 流式 + 思考条 + 停止按钮
      + 新会话 / 切换 / 重命名 / 归档 / 删除
- [x] 移除 `/chat` 的 `DemoBanner`
- [x] `reasoning` 帧进折叠思考条（**不混进正文**）；`text` 帧进正文
- [x] 历史倒序 → 正序（服务端返回最新在前）
- [x] 会话列表过滤 `webui:` 前缀

### ★ 实现中发现并绕过的契约不一致

归档/删除路由（`server.ts`）用**原始 id** 做 `startsWith('webui:')` 校验，必须带
`webui:private:` 前缀；而会话列表给的是带前缀的完整 id、chat 路由却用 `cleanSid` 兼容裸 id。
我第一版传裸 id → 会 **403「QQ 会话不可删除」**。

webui 是靠"删除对话框传完整 id、切换会话传裸 id"绕过的（混用）。
console 改为**显式补前缀**（`webui:private:${cleanSid(id)}`），不依赖调用方传什么。

### 测试

- [x] `tests/stream.test.ts`（13 用例）：正常帧序列、**分片边界三种**（事件被拆 / 一分片多事件 /
      `\n\n` 落在边界）、畸形 JSON 跳过、非 data 行忽略、HTTP 非 2xx、网络失败、
      **fetch 确实收到 signal**、**abort → StreamAbortedError 且不再回调**

## 实测验收（2026-09-25）

服务端 SSE 直连（`curl -N`）：`connected` → 大量 `reasoning` 帧（逐字思考）→ …；
历史端点确认 **user 消息与 assistant 回复都落库**（回复是她真实语气的完整段落）。

console 侧（无头 Edge `--dump-dom`）：

| 项 | 结果 |
|---|---|
| 「演示数据」残留 | **0**（原 2） |
| 「尚未接入」 | **0**（原 2） |
| 界面元素 | 新会话 / 空态文案 / 输入框 / 「记忆与人格已接入」全在 |
| 会话列表 | ✅ 实时渲染出 probe 会话（2 条，含时间） |
| 报错 | 无 |

截图确认布局：左侧 AppShell 侧栏（她的**真实实时状态**：在线·开心 + 当前活动）、
中间会话列表、右侧聊天区。**`/chat` 现已是全站最后一个演示页清零。**

清理：probe 会话已用 `DELETE /api/sessions/webui:private:<id>` 删除并确认从列表消失
（顺带验证了补前缀修复是对的）。

## Apply 任务

- [x] `openspec/specs/alysia-console/spec.md`：新增 §5.1 聊天 / §5.2 流式帧与中断 / §5.3 解析边界；
      `/chat` 移出「未接入」表
- [x] 更新 `docs/HANDOFF.md`
- [x] 回归 + 重建前端产物

## 遗留

- **表情包渲染未接**：回复里的 `[表情包:名字]` 现在会原样显示成文字
  （webui 会渲染成贴图，走 `GET /api/stickers/file/:name`）。独立后续 change
- **`/api/chat/pending` 未用**：已封装 `chatApi.pending()`，但页面还没做
  「刷新后恢复回复中状态」。当前刷新会丢掉进行中的流（服务端仍会生成并落库）
- `/desktop` 仍是形态预览页（数据为样例）

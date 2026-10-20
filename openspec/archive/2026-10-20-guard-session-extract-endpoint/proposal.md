# Change Proposal: guard-session-extract-endpoint

## 元信息

- **日期**: 2026-10-20
- **类型**: FIX（安全边界 + 失败可见性）
- **状态**: pending → 本轮直接 apply
- **影响 spec**: `server-hardening`（新增一节「会话结算端点的来源/存在性校验」）
- **KI**: KI-18

## 这条要解决什么

`POST /api/sessions/:id/extract` 对 `id` **不设任何校验**（`packages/server/src/webui/server.ts:418`）：

```ts
app.post('/api/sessions/:id/extract', async (req) => {
  const { id } = req.params as { id: string };
  const result = await core.memoryManager.extractProfile(id);   // ← id 直接进结算
  return result;
});
```

而同文件的邻居都有边界：

| 端点 | 边界 |
|---|---|
| `/api/ingest` | 只收 `dsh:` 前缀（`ingest.ts:41`） |
| `/api/sessions/:id/archive` | 只收 `webui:` |
| `/api/sessions/:id`（DELETE） | 只收 `webui:` |
| **`/extract`** | **无** |

## 为什么这是真问题（不是洁癖）

1. **成本**：任意 id 都能触发一次结算 = 摘要 + 画像提取 + 人格确认，
   全是真 LLM 调用（摘要槽本身就是本项目已爆三次预算事故的那个槽）。
2. **正确性**：结算不该发生在不该结算的会话上。
3. **历史同族**：2026-10-02 的子 agent 污染事件里，它正是「插件回传 + 结算」链路的落点
   —— 插件侧过滤已堵住那一条，但**端点本身仍然敞着**。
4. **失败不可见**：会话不存在时，`extractProfile` 返回的是
   `{ factsExtracted: 0, summaryGenerated: false }` —— 一个**成功形状的空转**，
   Web 端「提取画像」按钮分不清「这个会话很干净」和「这个会话根本不存在」。

## 需求

1. **形状校验**（路由层）
   - `id` 非空、不含 `/`
   - 拒 `dsh:unknown`（复用 `ingest.ts` 的 `UNKNOWN_SESSION_ID` 常量，不新造字符串）
2. **存在性校验**（路由层，响亮失败）
   - 该会话 `countSessionEvents(id) === 0` ⇒ **404** + 明确原因
   - 判据用「有没有事件」而不是「会不会产生新事实」——后者是结算的结果，不能拿来当入口判据
3. **新 core 方法**（遵守「Web 端接口兼容」硬约束）
   - `MemoryManager.countSessionEvents(sessionId: string): number`
   - 纯数据、只读；底层直接用已存在的 `EventStore.countBySession`
   - 同步登记 `docs/Web-API-Design.md`

## 不做

- **不加**「只允许 dsh: 前缀」——extract 同时服务 WebUI 会话的手动提取，
  按来源一刀切会砍掉合法用法（这正是当初没加校验的合理部分）
- 不改 `extractProfile` 的返回契约（已在 9-25 修过 `summaryGenerated` 的含义，不动它）

## 对账方向

KI-18 = 同文件邻居有边界、这条没有 ⇒ **改 impl，不改 doc**（doc 从没说过它可以不设防）。

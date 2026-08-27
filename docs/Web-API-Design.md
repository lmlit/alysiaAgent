# Alysia Web 端接口档案（服务端开发约束）

> 日期: 2026-07-31（2026-08-07 治理对账更新状态）
> 状态: ✅ 已实现（WebUI 路由层在 packages/server/src/webui/server.ts，routes exercise all core methods）
> 目标: 为 WebUI 管理面板（Fastify + Vue）提供完整的后端接口清单
> ★ 约束: **后续开发服务端功能时，新增/修改 core 方法必须先对照本文档**，
>   确保不破坏 Web 端接口契约，避免 Web 端开发时返工回归。

## 0. 服务端开发约束（必读）

### 0.1 新增服务端功能时的检查清单

- [ ] 新功能是否需要在 Web 端展示/操作？（会话、画像、人格、Token、知识库、平台状态）
- [ ] 如果是 → 在 `MemoryManager`（或 `AlysiaCore`）暴露公开方法，**不在 pipeline/adapter 内部闭包**
- [ ] 方法返回**纯数据**（JSON 可序列化），不返回 DB 句柄/类实例
- [ ] 方法名遵循快照/操作命名：`get*Snapshot()` 读、`extract*()`/`adjust*()` 写
- [ ] 同步方法用 `list*()`/`get*()`，异步操作用 `Promise`，Web 路由层只做薄包装
- [ ] 新增方法更新本文档第 2/3 节（🟢 已封装 / ⬜ 待实现）

### 0.2 禁止事项

- ❌ 不把 `setExtra/getExtra` 或 pipeline 内部状态直接暴露给 Web
- ❌ 不在 adapter 里写死 Web 端要用的业务逻辑（画像是 core 的职责）
- ❌ 新增 store 方法时跳过 MemoryManager 门面（Web 只允许走 MemoryManager 公开接口）

### 0.3 命名约定

| 前缀 | 含义 | 示例 |
|------|------|------|
| `get*Snapshot` | 只读快照（Web 展示） | `getProfileSnapshot` |
| `list*` | 列表查询 | `listSessions` |
| `extract*` | LLM 提取类操作 | `extractProfile` |
| `adjust*` | 参数调整（带护栏） | `adjustPersona`（待实现） |
| `import*` | 外部数据导入 | `importKnowledge`（待实现） |

---

## 1. 接口总览

| 分组 | 接口 | 用途 | 状态 |
|------|------|------|:--:|
| 系统 | `GET /api/health` | 健康检查 | 🟢 core 已封装 |
| 会话 | `GET /api/sessions` | 会话列表 | 🟢 core 已封装 |
| 会话 | `POST /api/sessions/:id/extract` | 手动提取画像 | 🟢 core 已封装 |
| 画像 | `GET /api/profile` | 画像快照 | 🟢 core 已封装 |
| 人格 | `GET /api/persona` | 人格状态 | 🟢 core 已封装 |
| 人格 | `POST /api/persona/adjust` | 手动调整人格参数 | 🟢 core 已封装 |
| Token | `GET /api/stats` | Token 用量统计 | 🟢 core 已封装 |
| 知识库 | `GET /api/knowledge` | 知识文档列表 | 🟢 core 已封装 |
| 知识库 | `POST /api/knowledge/import` | 导入知识（文本；PDF/URL 后续） | 🟢 core 已封装 |
| 知识库 | `DELETE /api/knowledge/:id` | 删除知识文档 | 🟢 core 已封装 |
| 平台 | `GET /api/platforms` | 平台连接状态 | ⬜ 未实现（backlog，见 openspec/changes/add-platforms-endpoint） |
| 角色 | `GET /api/roles` | 角色列表 | 🟢 core 已封装 |
| 角色 | `GET /api/roles/active` | 当前激活角色 | 🟢 core 已封装 |
| 角色 | `POST /api/roles/switch` | 切换角色 | 🟢 core 已封装 |
| 角色 | `POST /api/roles/import` | 导入角色包 | 🟢 core 已封装 |
| 角色 | `GET /api/roles/:id/export` | 导出角色包 | 🟢 core 已封装 |
| 素材 | `GET /api/stickers` | 表情包列表（findSticker） | 🟢 core 已封装 |
| 隐私 | `POST /api/privacy` | 隐私模式切换 | 🟢 core 已封装 |
| 生活 | `GET /api/life` | AI 生活状态快照 + 事件流 | 🟢 core 已封装 |

> 🟢 = core 方法已就绪，只需 Web 路由层包装
> ⚠️ = 部分就绪，需补充
> 空白 = 需要新增功能

---

## 2. Core 已封装的接口（直接可用）

### 2.1 `GET /api/sessions` — 会话列表

**Core 方法**: `MemoryManager.listSessions(limit)`

```typescript
// core/src/memory/MemoryManager.ts
listSessions(limit: number = 20): Array<{
  sessionId: string;      // "qq-official-1:private:private_xxx"
  messageCount: number;   // 消息数
  lastActive: string;     // ISO 时间
}>
```

**响应示例**:
```json
{
  "sessions": [
    { "sessionId": "qq-official-1:private:private_DD71...", "messageCount": 12, "lastActive": "2026-08-01T15:08:36.953Z" },
    { "sessionId": "qq-official-1:group:group_5913...", "messageCount": 5, "lastActive": "2026-08-01T15:15:32.000Z" }
  ]
}
```

**Web 用途**: 会话管理页左侧列表

---

### 2.2 `POST /api/sessions/:id/extract` — 手动提取画像

**Core 方法**: `MemoryManager.extractProfile(sessionId)`

```typescript
extractProfile(sessionId: string): Promise<{
  factsExtracted: number;    // 本次新增 facts 数
  summaryGenerated: boolean; // 是否生成了对话摘要
}>
```

**响应示例**:
```json
{ "factsExtracted": 2, "summaryGenerated": true }
```

**Web 用途**: 画像页"手动提取"按钮。点击后对指定会话执行 LLM 提取：
- 对话摘要 → conversations 表
- 用户消息 → LLM 提取 facts → 冲突合并入画像
- 自动排除 NPC 消息（skip_profile）

---

### 2.3 `GET /api/profile` — 画像快照

**Core 方法**: `MemoryManager.getProfileSnapshot()`

```typescript
getProfileSnapshot(): {
  facts: Array<{ fact: string; confidence: number; source: string; status: string }>;  // 已过滤 superseded
  basics: string;      // 深度画像摘要（自然语言）
  preferences: string; // 偏好 JSON
}
```

**Web 用途**: 画像展示页。facts 列表 + 深度摘要。

---

### 2.4 `GET /api/persona` — 人格状态

**Core 方法**: `MemoryManager.getPersonaSnapshot()`

```typescript
getPersonaSnapshot(): {
  name: string;
  tone: { formality: number; warmth: number; humor: number; directness: number };
  speechStyle: { sentence_length: number; emoji_usage: number; code_heavy: number };
  emotionalRange: { expressiveness: number; empathy: number; playfulness: number };
  memoryConfig: MemoryConfig;  // 记忆旋钮
}
```

**Web 用途**: 人格可视化面板（雷达图/滑块）。数值范围 [-1, 1]。

---

## 2.5 角色系统（2026-08-02 已封装）

| Core 方法 | 用途 |
|-----------|------|
| `listRoles()` | 角色列表（含 worldbook 条目数） |
| `switchRole(roleId)` | 切换激活角色 |
| `importRole(RolePackage)` | 导入角色包（人格 + 世界书 + 素材） |
| `exportRole(roleId)` | 导出角色包 |
| `getActiveSystemPrompt()` | 激活角色主人格提示词 |

**角色包格式**（`RolePackage`，见 `docs/superpowers/specs/2026-07-31-role-system.md`）：
```json
{ "role": "id", "name": "显示名", "system_prompt": "...", "persona": { tone/speech_style/emotional_range/memory_config }, "worldbook": [{ trigger_keys, content, content_type: "text|image|sticker" }] }
```

**表情包素材** = worldbook 条目 `content_type: "image"`（触发词 → 图片 URL），复用 WorldbookMatcher 关键词匹配。

---

## 2.6 生活系统（AI 主动生活，2026-08-06 已封装；8-27 叙事化重构增量）

**Web 路由**: `GET /api/life` → `{ snapshot, events }`（快照 + 近 7 天事件流）

| Core 方法 | 用途 |
|-----------|------|
| `getLifeSnapshot()` | AI 生活状态快照（活动/心情/亲密度/**moodValue 8-27 新增**） |
| `listLifeEvents(days)` | 生活事件列表（默认 7 天，含 id/wbEntryId/delivered/**origin 8-27 新增**） |
| `listLifeSummaries(days)` | 近 N 天每日生活摘要（生成器回顾用） |
| `recordLifeEvent(...)` | 记录 AI 生活事件（LifeService 内部，返回事件 id；**origin 8-27 新增**） |
| `markLifeEventDelivered(id)` | 标记事件已推送（delivered=1，LifeService 推送成功后） |
| `bumpWorldbookHit(id)` | 世界书命中统计 hit_count+1（事件引用时） |
| `getLifeEventInjection()` | 事件流注入块（PromptAssembler 用） |
| `getWorldbookSample(n)` | 世界书分层采样（**8-27 起 life_event 3 + text 2 随机，截断 200 字**） |
| `getUserActivitySummary()` | 用户近况摘要（事件生成用） |
| `updateLifeState(partial)` | 更新 AI 实时状态（**moodValue 8-27 新增**） |
| `upsertDailySummary(date, summary)` | 写入/更新某天生活摘要 |
| `listLifeTemplates()` | 生活模板池列表（seed + self；**category/groupName 8-27 新增**） |
| `addLifeTemplate({activity, type})` | 昔涟自加生活模板（机械预检 + LLM 校验，weight 固定 2） |
| `deleteLifeTemplate(id)` | 删除生活模板（仅用户指令，日志留底） |
| `listScenePresence()` | ★ 8-27 配角在场状态列表（name/status/basis/updatedAt） |
| `listPresentCharacters()` | ★ 8-27 当前在场配角名（事件生成注入用） |
| `upsertScenePresence(name, status, basis?)` | ★ 8-27 更新在场状态（事件提到谁 → present；24h 无提及 → off-scene） |

## 2.7 内容自进化（worldbook 自写，2026-08-14 已封装）

**Web 路由**: `GET /api/worldbook` → `{ entries }`；`DELETE /api/worldbook/:id` → `{ ok }`
**Web 路由**: `GET /api/life/templates` → `{ templates }`；`DELETE /api/life/templates/:id` → `{ ok }`

| Core 方法 | 用途 |
|-----------|------|
| `addWorldbookEntry({triggerKeys, content})` | 昔涟自写世界书条目（机械预检 + LLM 校验，source='self'） |
| `listWorldbookEntries()` | 世界书条目列表（含 source：seed/self，硬审计面） |
| `deleteWorldbookEntry(id)` | 删除世界书条目（仅用户指令驱动，日志留完整内容可找回） |
| `getSessionMessages(sessionId, limit, before?)` | ★ 8-15 会话消息历史（created_at 游标分页，时间倒序） |

## 2.8 聊天端点（WebUI，2026-08-15 已封装）

**Web 路由**:
- `POST /api/chat/prompt` → `{ok, sessionId, reply}` — 注入消息进 pipeline（记忆/人格/生活全链路），非流式完整回复，90s 超时
- `POST /api/chat/stream` → SSE 帧流 — `connected / chunk{kind,text} / done{reply} / aborted / error`
- `GET /api/sessions/:id/messages?limit=&before=` → `{ok, sessionId, messages, hasMore}` — 历史分页（游标向下翻页）
- `GET /api/chat/pending?sessionId=` → `{ok, inFlight}` — 会话在途生成状态

**会话命名**:`webui:private:<id>`（与 QQ 通道完全隔离，归入私聊记忆隔离）

---

## 3. 需要新增的接口

### 3.1 `POST /api/persona/adjust` — 手动调整人格

```typescript
// 请求体
{ param: "tone.warmth", delta: 0.05, reason: "手动调整" }

// 响应
{ applied: true, newValue: 0.25 }
```

**Core 需要**: `MemoryManager.adjustPersona(param, delta, reason)` — 包装 PersonaAdapter.apply()（带护栏）。

### 3.2 `GET /api/stats` — Token 统计

**现状**: `getSessionStats(sessionId)` 在 `llm-agent.ts`（模块级 Map + JSON 持久化）。

**问题**: 目前只能按 session 查，且 Web 端需要全局汇总。

**Core 需要**: `MemoryManager.getTokenStats(sessionId?)` — 汇总所有会话。

### 3.3 `GET /api/knowledge` + `POST /api/knowledge/import`

**现状**: 已实现（2026-07-31）。`MemoryManager.importKnowledge({title, content, source})` — hash 去重 → 分块(500/overlap 50) → knowledge_chunks 表 → 向量（待 LanceDB）。`listKnowledgeDocs()` / `deleteKnowledgeDoc()` 已封装。

**Web 路由**（待实现）:
```typescript
app.get('/api/knowledge', async () => ({ docs: core.memoryManager.listKnowledgeDocs() }));
app.post('/api/knowledge/import', async (req, reply) => {
  const result = await core.memoryManager.importKnowledge(req.body);
  return result;
});
app.delete('/api/knowledge/:id', async (req, reply) => {
  core.memoryManager.deleteKnowledgeDoc(req.params.id);
  return { ok: true };
});
```

### 3.4 `GET /api/platforms` — 平台状态

**Core 需要**: `AlysiaCore.getPlatformStatus()` — 返回各 adapter 的连接状态。

---

## 4. Web 路由层设计（Fastify）

```typescript
// packages/server/src/webui/server.ts (待实现)
import Fastify from 'fastify';

const app = Fastify({ logger: true });

// ── 系统 ──
app.get('/api/health', async () => ({ status: 'ok' }));

// ── 会话 ──
app.get('/api/sessions', async (req, reply) => {
  const sessions = core.memoryManager.listSessions(20);
  return { sessions };
});

app.post('/api/sessions/:id/extract', async (req, reply) => {
  const result = await core.memoryManager.extractProfile(req.params.id);
  return result;
});

// ── 画像 ──
app.get('/api/profile', async () => core.memoryManager.getProfileSnapshot());

// ── 人格 ──
app.get('/api/persona', async () => core.memoryManager.getPersonaSnapshot());

// ── 静态文件 (Vue SPA) ──
app.register(require('@fastify/static'), { root: './webui/dist' });

await app.listen({ port: config.server.port });
```

---

## 5. 实施顺序

| 阶段 | 内容 |
|------|------|
| **P0** | Fastify 骨架 + `/api/health` + `/api/sessions` + `/api/profile` + `/api/persona`（core 已封装，纯路由） |
| **P1** | `/api/sessions/:id/extract`（core 已封装）+ Token stats 封装 |
| **P2** | 人格手动调整 + 知识库导入 + 平台状态 |
| **P3** | Vue SPA 前端 |

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-31 | 初始设计。core 封装 4 个方法：listSessions / extractProfile / getProfileSnapshot / getPersonaSnapshot |
| 2026-08-06 | Task 7：生活系统接口全部封装（getLifeSnapshot / listLifeEvents / recordLifeEvent / getLifeEventInjection / getWorldbookSample / getUserActivitySummary / updateLifeState / upsertDailySummary），Web 路由 `GET /api/life` 上线 |

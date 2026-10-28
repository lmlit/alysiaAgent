# Alysia Web 端接口档案（服务端开发约束）

> 日期: 2026-07-31（2026-08-07 治理对账更新状态）
> 状态: ✅ 已实现（WebUI 路由层在 packages/server/src/webui/server.ts，routes exercise all core methods）
> 目标: 为 Web 管理面板（Fastify 路由层 + `packages/console`）提供完整的后端接口清单
> ★ 约束: **后续开发服务端功能时，新增/修改 core 方法必须先对照本文档**，
>   确保不破坏 Web 端接口契约，避免 Web 端开发时返工回归。
> ★ 鉴权（2026-08-29, cr-p0-webui-auth）: 服务模式下所有 `/api/*` 需
>   `Authorization: Bearer <server.webuiToken>`（`/api/health` 豁免，桌面模式免鉴权）。
>   前端: `setWebuiToken(token)` 存 localStorage 后自动附加；401 → 登录遮罩。
>   契约见 `openspec/specs/server-hardening/spec.md` §6。
>
> ★ **双令牌**（2026-10-19, `wake-her-on-task-result`）：另有 `server.runnerToken`
>   （`ALYSIA_RUNNER_TOKEN`）供宿主 runner / 后台 dsh 使用。它**只**放行：
>   `GET /api/persona/prompt`、`POST /api/ingest`、`POST /api/memory/read`、
>   `POST /api/sessions/:id/extract`、`/api/project-tasks*`、`POST /api/host/pages`、
>   `POST /api/vision/describe`。越权 ⇒ **403**（不是 401：它是被识别的调用方）。
>   目的：后台执行体不再握管理面（角色导入/知识库删除/隐私开关等一律拒绝）。
>
> ★ 消费方（2026-09-24, adopt-nextjs-console；**2026-10-02 收敛**）:
>   **唯一消费方 = `packages/console`**（Next.js，spec `alysia-console`）。
>   `packages/webui`（Vue）已于 2026-10-02 删除（change: remove-packages-webui）——
>   新增/修改端点**只需考虑 console 一个前端**。
>   token 键名 `webui_token` 是**遗留契约、不得改名**（用户浏览器里已存的 token 认这个键）。
>
> ✅ 原缺口已补（2026-09-25, add-life-readonly-endpoints）:
>   `GET /api/life/summaries`（每日摘要）、`GET /api/life/companions`（配角在场）已上线路由。

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
| 画像 | `GET /api/profile` | 画像快照（`?includeSuperseded=1` 带已作废的） | 🟢 core 已封装 |
| 画像 | `POST /api/profile/facts/correct` | **纠正**一条用户事实（旧的作废 + 写新的） | 🟢 core 已封装（2026-10-16） |
| 画像 | `POST /api/profile/facts/confirm` | **失效**（或续期）一条事实 | 🟢 core 已封装（2026-10-16） |
| 画像 | `GET /api/profile/conflicts` | 新旧事实冲突候选 + 队列统计 | 🟢 2026-10-28（`resolve-fact-conflicts`） |
| 画像 | `POST /api/profile/conflicts/:id/resolve` | 裁决冲突（`keep=old\|new`） | 🟢 2026-10-28 |
| 人格 | `GET /api/persona` | 人格状态 | 🟢 core 已封装 |
| 人格 | `POST /api/persona/adjust` | 手动调整人格参数 | 🟢 core 已封装 |
| Token | `GET /api/stats` | Token 用量统计 | 🟢 core 已封装 |
| 知识库 | `GET /api/knowledge` | 知识文档列表 | 🟢 core 已封装 |
| 知识库 | `POST /api/knowledge/import` | 导入知识（文本；PDF/URL 后续） | 🟢 core 已封装 |
| 知识库 | `DELETE /api/knowledge/:id` | 删除知识文档 | 🟢 core 已封装 |
| 平台 | `GET /api/platforms` | 平台接入状态（**已接入事件总线的 scope**） | 🟢 core 已封装（2026-10-16） |
| 角色 | `GET /api/roles` | 角色列表 | 🟢 core 已封装 |
| 角色 | `GET /api/roles/active` | 当前激活角色 | 🟢 core 已封装 |
| 角色 | `POST /api/roles/switch` | 切换角色 | 🟢 core 已封装 |
| 角色 | `POST /api/roles/import` | 导入角色包 | 🟢 core 已封装 |
| 角色 | `GET /api/roles/:id/export` | 导出角色包 | 🟢 core 已封装 |
| 素材 | `GET /api/stickers` | 表情包列表（findSticker） | 🟢 core 已封装 |
| 素材 | `GET /api/stickers/file/:name` | 表情包贴图文件（读文件返回，带 Content-Type/Cache-Control） | 🟢 路由在 `server.ts`（★ 10-02 从 `webui-system` §6 补登记——该 spec 是它此前的唯一书面记录） |
| 隐私 | `POST /api/privacy` | 隐私模式切换 | 🟢 core 已封装 |
| 生活 | `GET /api/life` | AI 生活状态快照 + 事件流 | 🟢 core 已封装 |
| 生活 | `GET /api/life/summaries` | 近 7 天每日生活摘要 | 🟢 2026-09-25 上线路由 |
| 生活 | `GET /api/life/companions` | 配角在场状态（含离场） | 🟢 2026-09-25 上线路由 |
| 生活 | `GET /api/life/templates` | 生活素材库（种子 + 自创） | 🟢 core 已封装 |
| 生活 | `GET /api/life/her-records` | **她的叙述记录**（kind=diary\|reflection, visibility=shared\|private, limit） | 🟢 2026-10-25 上线（listHerRecords） |
| 生活 | `GET /api/life/private-diaries` | 私密日记（不加滤镜那本，别名） | 🟢 2026-10-25 上线 |

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
  // ★ 2026-10-21（change: unify-memory-eligibility，契约 C4）：
  //   摘要与事实是两个独立任务，必须分别可判 ——
  //   `factsExtracted: 0` 有两种含义（"看了确实没有" / "提取失败"），只给数字分不清。
  factsStatus: 'ok' | 'failed' | 'skipped';
}>
```

**响应示例**:
```json
{ "factsExtracted": 2, "summaryGenerated": true, "factsStatus": "ok" }
```

**失败示例**（摘要成功但事实提取失败 —— 2026-10-21 之前这种情况**完全看不出来**）：
```json
{ "factsExtracted": 0, "summaryGenerated": true, "factsStatus": "failed" }
```
失败窗口会落 `conversations.facts_status='failed'`，由 cron `retryFailedFactExtraction()` 自动补 1 次（D3）。

**Web 用途**: 画像页"手动提取"按钮。点击后对指定会话执行 LLM 提取：
- 对话摘要 → conversations 表
- 用户消息 → LLM 提取 facts → 冲突合并入画像
- 自动排除 NPC 消息（skip_profile）

**窗口语义**（2026-10-11 `fix-session-end-window`）：只处理
**该会话最新一条摘要 `ended_at` 之后**的事件（无历史摘要则回退 24h 前）。
签名与返回结构不变——但修复前该入口**不传窗口锚点**，会落到
「全历史最近 1000 条事件」，即点一次按钮就重摘数十天历史
（线上实测窗口跨度 46~61 天）。契约见 `openspec/specs/memory-system/spec.md` §5.4.1。

**超时语义**（2026-10-11 `add-memory-llm-timeout`）：本接口内部调用记忆链路
LLM 客户端，该客户端有 **120s 超时**。超时会让本请求以错误结束（而非无限挂起）——
修复前线上实测该接口曾**挂住 117 分钟**（KI-21）。
签名与返回结构不变；超时可重试，失败窗口由 cron 的补处理机制兜底。

**入口校验**（2026-10-20 `guard-session-extract-endpoint`，KI-18）：本接口此前
**对 `id` 不设任何校验**（同文件邻居都有边界：`/api/ingest` 只收 `dsh:`、
archive/delete 只收 `webui:`），任何过了鉴权的调用方都能对任意会话触发结算。

| 情形 | 状态码 | 说明 |
|---|---|---|
| 正常会话 | 200 | 原行为不变 |
| `id` 为空 / 解码后含 `/` | **400** | 畸形 id，不进结算 |
| `dsh:unknown` | **400** | **拒**：它是适配器拿不到 `session.id` 时的退化桶，不是真实会话 |
| 该会话**零事件** | **404** | 「会话不存在」不许长得像「提取成功」 |

新 core 方法（只读、纯数据）：`MemoryManager.countSessionEvents(sessionId): number`
—— 包装 `EventStore.countBySession`。判据刻意用「有没有事件」而不是
「会不会产出新事实」：后者是结算的**结果**，拿来当入口判据会把「干净但真实」的会话误杀。

⚠️ **刻意不加**「只允许 `dsh:` 前缀」：本接口同时服务 WebUI 会话的手动提取。

---

### 2.3 `GET /api/profile` — 画像快照

**Core 方法**: `MemoryManager.getProfileSnapshot()`

```typescript
getProfileSnapshot(opts?: { includeSuperseded?: boolean }): {
  facts: Array<{ fact: string; confidence: number; source: string; status: string;
                 updatedAt: string; validFrom: string; category: string }>;  // 默认已过滤 superseded
  characterFacts: Array<{ fact: string; confidence: number; source: string; status: string;
                          updatedAt: string; validFrom: string; category: string }>;  // ★ 8-28 角色事实（昔涟自己的事）
  basics: string;      // 深度画像摘要（自然语言）
  preferences: string; // 偏好 JSON
}
```

**Web 用途**: 画像展示页。facts(用户)+ characterFacts(角色)并列 + 时间列 + 分类。

**★ 8-28 补充**: `MemoryManager.ingest(event)` 支持 `event.perspective`('interaction' 默认 | 'self' 生活事件回写);`read({perspective})` 可按视角过滤召回。

**★ 2026-10-16（记忆纠正首版）**：
- `GET /api/profile?includeSuperseded=1` → `getProfileSnapshot({ includeSuperseded: true })`，
  **连已作废的一起返回**。纠正页需要看到"被作废的"，否则用户无法确认「旧事实真的失效了」。
  默认仍过滤（画像展示只要"她现在相信的"）。

---

### 2.3.1 `POST /api/profile/facts/correct` — 纠正一条用户事实

**Core 方法**: `MemoryManager.correctProfileFact(oldFact, newFact)`

```typescript
correctProfileFact(oldFact: string, newFact: string): { superseded: boolean; added: boolean }
```

请求 `{ oldFact: string; newFact: string }` → 响应 `{ ok: true, superseded, added }`。

- **语义 = 两步一起做**：先把旧事实按 `factKeyOf` 归一化后标记 `superseded`，
  再写入新事实（`source: 'user'`）。
- ⚠️ **为什么不能只 `addFacts([新])`**：冲突检测按 `normalizeKey` 的**文本相似**判定，
  而「用户在长沙」→「用户在上海」**并不相似** ⇒ 不会互相 supersede ⇒
  **两条同时 active** ⇒ 召回同时拿到，用户看到自相矛盾的她。
- `source: 'user'` 是刻意的：`ProfileStore` 的既有规则是「用户声明不被 inferred 覆盖」，
  所以手动纠正**不会被后续 LLM 提取顶掉**。
- `superseded: false` = **没找到旧事实**（不是失败，旧文案可能已被改写过），新事实仍写入。
- 参数缺失/为空 → **400 + 具体原因**；core 抛错 → 400（不吞）。
- **Web 用途**: `/memory` 页的「纠正」按钮。
- ⚠️ **首版只支持用户事实**（`facts`）。角色事实（`character_facts`）在页面上**只读** ——
  `ProfileStore` 没有按 key 作废角色事实的方法，需要单独加，不在首版。

### 2.3.2 `POST /api/profile/facts/confirm` — 失效 / 续期

**Core 方法**: `MemoryManager.confirmProfileFact(fact, stillValid)`

请求 `{ fact: string; stillValid: boolean }` → 响应 `{ ok, found }`。

- `stillValid: false` → 作废（"使旧事实失效"的通道）；`true` → 按分类续期。
- `ok/found` **两个字段都有意保留**：`false` = **没找到这条事实**，
  与"操作失败"（HTTP 非 2xx）是**两回事**，前端据此给不同文案。
- ⚠️ **这条路此前不存在**：`confirmProfileFact` 早就实现了，但全仓**没有任何调用方**
  ⇒ 能力一直不可达（`/api/profile` 只能看、不能改）。2026-10-16 补上。
- **Web 用途**: `/memory` 页的「忘掉」按钮。

### 2.3.3 `GET /api/profile/conflicts` + `POST /api/profile/conflicts/:id/resolve` — 新旧事实冲突

**Core 方法**: `MemoryManager.listFactConflicts(limit)` /
`resolveFactConflict(conflictId, keep)`

- `GET` → `{ ok, pending: FactConflict[], stats: { pending, kept_old, kept_new, expired } }`；
  `pending` 不受“提问冷却”限制（给 console 看全量），但仍会过期。
- `POST /:id/resolve` 请求 `{ keep: "old" | "new" }`：
  - `new` → 旧条 superseded、新条 active + `confirmed_at`；
  - `old` → 旧条按分类续期、候选丢弃；
  - 已裁决/找不到 → **404**；`keep` 非法 → **400**。
- **Web 用途**: 画像页“待确认”区；聊天里的提问由 `[需要确认的事]` 块 + 工具完成，
  这个 API 是人工排查/后台操作入口。

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

### 2.4.1 `GET /api/persona/prompt` — 人设文本（2026-10-01 新增）

**Core 方法**: `MemoryManager.getCompactPersonaPrompt(sections = 4)` → `{ prompt: string }`

「紧凑人设」= `getActiveSystemPrompt()` 的前 N 节（丢掉 worldbook 类的大段设定，
实测 66 节全量约 15k 字符，只取 4 节约 6.4k）。

**用途**: **dsh 侧动态人设的读通道**（change: connect-dsh-alysia-bridge）。

★ 与聊天管线取**同一份文本**（同一方法）——各写各的会让她在 dsh 里和 QQ 里变成两个人。
原先是 `llm-agent.ts` 的一句内联表达式，本次提取成 `MemoryManager` 公开方法。

### 2.4.2 `POST /api/ingest` — 喂入外部会话事件（2026-10-01 新增）

**Core 方法**: `MemoryManager.ingest(event)`

```
请求  { events: MemoryEvent[] }             单批 ≤ 200，超出 413
响应  { ok: true, accepted: number, rejected: string[] }
```

**用途**: **dsh 记忆回传的写通道**（双进程模型：alysia server 是记忆的唯一写入者，
dsh 插件只回传原始事件；提取 / 5 道护栏 / 事实去重 / supersede 冲突解决全在这边）。

★ **只接受 `dsh:` 前缀的会话**——写接口不该能往 QQ / WebUI 会话里注入消息。
前缀同时是**来源标记**（与 `webui:` / `qq-official-1:` 同一约定，
故**未给 `EventSource` 加枚举值**，免得所有 switch 它的下游出现未覆盖分支）。

★ `rejected` 里的原因是**具体到字段**的人话（如 `payload.role 必须是 user/assistant`）——
静默丢弃会让回传方以为成功了。

校验与归一化在 `packages/server/src/ingest.ts`（纯函数，可独立单测）。

---

### 2.4.3 角色导入的字段合并语义（2026-10-01 修正）

**Core 方法**: `MemoryManager.importRole(pkg)` —— 对应 `POST /api/roles/import`

★ **包未提供的字段不再被空默认值覆盖**（change: fix-role-import-wipes-persona）。

原语义是「包没给就填空」——于是**只带 worldbook 的角色包**（线上那两个表情包包，
`role` 同为 `'alysia'`）在每次启动把昔涟的整行 persona 冲掉，**包括人格核心 `system_prompt`**。
`PersonaStore.get()` 会给空的 `tone`/`speech_style`/`emotional_range` 填回结构默认值，
所以只有 `system_prompt` 露出「空」的表象，**实际整行都在被冲**。

现语义：**包提供了就用包的；否则保留已有；都没有才落默认**。

| 包字段 | 行为 |
|---|---|
| `system_prompt` 给了（含空串） | 覆盖 |
| `system_prompt` 未给 | **保留原值** |
| `persona.tone/speech_style/emotional_range/memory_config` 给了 | 覆盖 |
| 同上未给 | **保留原值** |
| 目标是新 role（无既有行） | 落默认值（原行为不变） |

### 2.4.4 `POST /api/memory/read` — 记忆检索（2026-10-02 新增）

**Core 方法**: `MemoryManager.read()` + `assembleWithReport()`

```
请求  { query: string, mode?: 'chat'|'code', limit?: 1..20, sessionId?: string,
        blocks?: 'chat'|'code',           // ★ 2026-10-24 新增
        worldbookScope?: 'chat'|'code' }  // ★ 2026-10-24 新增
响应  { context: string, retrieved: SearchResult[] }
```

**用途**: **dsh 记忆的读通道**（change: bridge-memory-read）——
写通道（`/api/ingest`）负责把 dsh 的对话存进来，本接口负责让她**读得到**。

★ `context` 由 server 端**与聊天管线同一套**组装（同函数），
避免「dsh 里记起的」和「QQ 里记起的」不一致（同 `getCompactPersonaPrompt` 的教训）。

★ **空 `query` 也照常返回**：`[关于你]` / `[你的偏好]` / `[关于你的事实]` 等块
**不依赖 query**（直接读 store）。dsh 侧挂载预热正靠这一点——否则第一轮会一片空白
（dsh 的 prompt provider 是**同步**的，等不到异步检索）。

★ 用 POST 而非 GET：`query` 是用户原话，可能很长，且不该进 URL/日志历史。

#### ★ 2026-10-24：`mode` 一词三义已拆（change: `align-dsh-memory-blocks-with-scope`）

`mode` 原本同时决定三件事，而 dsh 场景下三者想要**不同值**，选谁都错一半：

| 语义 | dsh 想要 | 理由 |
|---|---|---|
| 世界书 scope | `code` | 干活的对话，不该触发闲聊条目 |
| 提示块表（**13 块** / 6 块） | `chat` | 人味块（关于你/偏好/事实/关于我/待确认/最近对话/情境提示/分寸）**只在 chat 表里** |
| token 预算（3200 / 2450） | 更大 | 编程会话本来就长（**本次未改**，另议） |

| 字段 | 作用 | 缺省 |
|---|---|---|
| `blocks` | **只**覆盖"用哪张块表" | `mode` |
| `worldbookScope` | **只**覆盖"世界书匹配哪个 scope"，且**显式给出 ⇒ 该 scope 条目注入 prompt**。⚠️ **仅对 `blocks='chat'` 生效**（`code` 表的 scope 是隐式的） | 不给 = 只匹配不注入（**与 2026-10-24 之前逐字相同**） |
| `mode` | 保留为语法糖（`blocks` / `worldbookScope` 的缺省值来源） | `chat` |

⚠️ **`worldbookScope` 的"显式才注入"不是权宜之计**：QQ/console 的产品决定是
"世界书走 `lookup_worldbook` 工具、不常驻 prompt"，那条边界不能因为 dsh 的 bug 被顺手改掉。

⚠️ **`[情境提示]` 是 optional 块**：预算不足时会被丢弃，那时 `worldbookInjected` 必须是 **0**
（"匹配到" ≠ "注入了"）。

**dsh 的调用形态**（`packages/dsh-adapter/src/alysia-client.ts`）：
`{ query, sessionId, limit, blocks: 'chat', worldbookScope: 'code' }`

**观测**：日志同时打**匹配数**与**注入数**——
`[memory/read] … worldbook 匹配 3 注入 3 条 / blocks=chat scope=code …`。
只打匹配数是历史教训：dsh 读通道自 **2026-10-02** 上线起，世界书"匹配到但全被丢弃"
持续 **22 天**（到 2026-10-24 发现为止），而日志看起来完全正常。

---

### 2.4.5 委托任务 `project-tasks`（2026-10-17 新增）

**Core 方法**: `MemoryManager.createProjectTask()` / `getProjectTask()` /
`listProjectTasks()` / `claimNextProjectTask()` / `submitProjectTaskResult()` /
`addProjectTaskRevision()`（均返回**纯数据**，见 `ProjectTaskStore` 的 `ProjectTask`）

**用途**: 聊天侧的她把工程活交给 dsh 执行（change: `add-project-task-delegation`）。
**服务端只做校验与状态，不执行** —— 真正跑 dsh 的是**宿主上的 runner**
（`scripts/project-task-runner.mjs`），因为 alysia server 在容器里、`dsh` 在宿主机上。

| 方法 | 路径 | 谁用 | 说明 |
|---|---|---|---|
| POST | `/api/project-tasks` | 聊天工具 | 创建。`requestKey` 去重；同项目在途 ⇒ **409 + 既有任务** |
| GET | `/api/project-tasks/next?projectId=` | **runner** | **原子认领**；空闲返回 `{ ok, task: null }`（空转是常态） |
| GET | `/api/project-tasks/:id` | 聊天工具 | 查状态/结果/产物 |
| POST | `/api/project-tasks/:id/revision` | 聊天工具 | 追加意见 ⇒ revision+1、回 `queued`、**沿用同一工程会话** |
| POST | `/api/project-tasks/:id/result` | **runner** | 回传终态；**落库 + 入队结果事件**（2026-10-19 起不再直接推送） |
| POST | `/api/project-tasks/:id/accept` | **主 Agent（她）** | **验收**：`needs_review` + revision 匹配 ⇒ `completed`（2026-10-19 新增） |

```
创建    { projectId, requestKey, goal, acceptanceCriteria?, originSessionId?, origin? }
        → 200 { ok, reason: 'created'|'deduped', task } | 409 { ok:false, reason:'busy', task }
认领    → 200 { ok, task, project: { id, workspace, profile }, nextPrompt, allowPublish }
        | 200 { ok, task: null } | 200 { ok, task:null, paused:{reason,until,message} }
回传    { status, dshSessionId?, result?, artifacts?, error?, claimToken? }
        → 200 { ok, task, eventId? } | 409（不在 running / 不是当前批次）
验收    { revision, by?, note? }
        → 200 { ok, task } | 409 { ok:false, error, task }（版本不对/不在待验收）
```

★ **`projectId` 必须在 `config.yml` 的 `projects:` 里登记过**；未登记 ⇒ 400 且**列出已登记的**。
模型**不能**自带工作目录或 dsh profile（那等于把「任意位置跑任意 profile」变成模型能力）。

★ **授权语义**：`origin='delegated'`（她在对话里决定交出去）vs `'user'`（用户显式下令），
带 `originSessionId` 以便结果回到原会话。

★ **runner 永远不写 `completed`**：那是「结果被接受」，属验收方；dsh 正常结束只写 `needs_review`。
拿不到终态/超时 ⇒ `unknown`，**绝不自动重投**（盲目重投会把同一份工作做两遍）。
**验收由她经 `/accept` 写**（★ 2026-10-19，`wake-her-on-task-result`）。

★ 2026-10-19（`wake-her-on-task-result`）：`result` 现在是「终态 + 事件入队」的**同一事务**；
投递由进程内 `al:subagent-wake` 领取（**不新开 HTTP 端点**），失败退避重试、重启后继续。
`claimToken`（= 认领时的 `attempts`）**可选**：带了就只接受当前批次，迟到结果一律 409。

⚠️ 该组端点与既有端点**同一套 Bearer 鉴权**（不新开通道）；
另有 **runner 令牌**（`server.runnerToken`）只能调白名单端点（见 §3.1）。

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

**Web 路由**:
- `GET /api/life` → `{ snapshot, events }`（快照 + 近 7 天事件流）
- `GET /api/life/summaries` → `{ summaries: [{date, summary}] }`（旧 → 新，窗口固定 7 天）
  —— ★ 2026-09-25 `add-life-readonly-endpoints` 补口
- `GET /api/life/companions` → `{ companions: [{name, status, basis?, updatedAt}] }`
  （`status`: `present` 在场 / `expected` 期待中 / `off-scene` 离场；只读，
  由 LifeService 巡检与事件生成维护，24h 无提及自动降级）—— ★ 同上补口

| Core 方法 | 用途 |
|-----------|------|
| `getLifeSnapshot()` | AI 生活状态快照（活动/心情/亲密度/**moodValue 8-27 新增**） |
| `listLifeEvents(days)` | 生活事件列表（默认 7 天，含 id/wbEntryId/delivered/**origin 8-27 新增**） |
| **`getLastUserMessageAt()`** | **最后一条「真人」消息的时间（ISO）/ null**。★ 2026-10-20（`tie-intimacy-to-speech`）：亲密度档位用它算 `idleDays`；**已排除** `skip_profile`/`synthetic` 机器注入与非 `message` 类型，**不过滤归档**。只读纯数据 |
| **`summarizeContextSlice({turns, previousSummary})`** | **把被上下文压缩丢弃的轮次压成一段回忆**（纯数据进出，**不落库、不改状态**）。★ 2026-10-20（`put-dropped-turns-back`）：由 `AgentHooks.summarizeDroppedTurns` 调用；⚠️ 显式走 `profile.deepRewrite` **纯文本**槽（默认槽是 json_object，会 400） |
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

**Core 方法**: `AlysiaCore.getPlatformStatus()`

```typescript
getPlatformStatus(): {
  platforms: Array<{
    name: string;                     // 平台 scope，形如 'qq-official-1::private'
    scheduler: 'default' | 'custom';  // 'default' = 用 core 默认调度器
  }>;
  count: number;
}
```

**Web 用途**: 展示「哪些平台已接入」。

**★ 2026-10-16 落地时的口径收敛（`add-platforms-endpoint`）—— 这条比接口本身更重要**：

原 §3.4 写的是「各 adapter 的**连接状态**」，但 **core 看不到连接层**：

- core 只知道 `registerPlatform(name)` 被调过 ⇒ 它能诚实回答的是
  「**哪些平台 scope 已接到事件总线**」；
- **WebSocket 是否连着 / 上次心跳或消息是什么时候** 属于 adapter 运行时状态，
  而当前三个适配器（qq-official / qq-onebot / telegram）**都没有暴露这类信息**。

⇒ 本接口**不编造** `connected` / `lastHeartbeat` 之类字段。
**假字段比没有字段更糟**——Web 端会把它当真，而它永远恒为真。
要真做「连接状态」，**前置是适配器先上报心跳**（独立的一块，不在本接口内）。

**已接入 ≠ 连通**：返回里有名字只说明装配期注册成功，不代表此刻对端可用。

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

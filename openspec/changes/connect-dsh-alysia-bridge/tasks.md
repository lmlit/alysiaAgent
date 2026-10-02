# Tasks: connect-dsh-alysia-bridge

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> **本 change 分两段**：本段只做 alysia server 侧（读+写通道），下一段做 dsh 插件接入。

## 前置调查（先查清「已有多少」，再决定造多少）

- [x] 列出现有路由（26 条）→ 发现 `POST /api/sessions/:id/extract` **就是**
      `sessionEndProcessor.process()`，**会话结算已经现成**，不必新建
- [x] 确认 `extractProfile()` == `sessionEndProcessor.process()`（`MemoryManager:1220`）
- [x] 确认 `EventSource` 无 `'dsh'` → 决定**不加枚举值**，用 session 前缀当来源标记
- [x] 定位「紧凑人设」的唯一定义点：`llm-agent.ts` 的内联表达式

## 本段（alysia server 侧）

### core

- [x] `MemoryManager.getCompactPersonaPrompt(sections = 4)` —— 从管线内联表达式提取
      （理由不是「好看」，是**只能有一处定义**：dsh 侧必须和管线取到同一份文本）
- [x] `llm-agent.ts` 改为调用它（行为逐字不变）
- [x] 回归测试锁定「提取未改变行为」：与旧表达式原样再算一遍比对
- [x] 修 `llm-agent.test.ts` 的 mock（补 `getCompactPersonaPrompt`）

### server

- [x] `src/ingest.ts`（新）：`validateIngestEvent` / `normalizeIngestEvent` /
      `MAX_INGEST_BATCH` / `DSH_SESSION_PREFIX`
      - **单独成文件**（`net.ts` 的先例）：`webui/server.ts` 一 import 就起服务器，没法单测
- [x] `GET /api/persona/prompt` —— 读通道
- [x] `POST /api/ingest` —— 写通道
      - 只接受 `dsh:` 前缀（安全边界 + 来源标记）
      - 单批 ≤ 200（超出 413）
      - 逐条独立 try/catch：单条失败不拖垮整批
      - 有拒收就 `logger.warn` + 响应体如实报出（**静默丢弃会让回传方以为成功了**）

### 测试

- [x] `tests/ingest.test.ts`（23 用例）：正例 / 前缀边界 / 逐字段反例 / 归一化 / 批次上限
- [x] `tests/memory/unit/compact-persona-prompt.test.ts`（5 用例）：与旧表达式一致、
      只取 4 节、节数可覆盖、单节不炸、空人设不抛

## 验收（2026-10-01，真启动 + curl）

用**隔离 dataDir** 启动（`ALYSIA_CONFIG` 指向临时配置）——**不写进生产库**
（她的记忆里有 63 万 token 的真实历史）。

| 项 | 结果 |
|---|---|
| 常规全仓 | ✅ **883 passed**（77 files） |
| core / server tsc | ✅ 均退出码 0 |
| 启动 | ✅ `13/13` + `10/10`，全新库 |
| `GET /api/persona/prompt` | ✅ 200，**4 节 / 6375 字**（紧凑形式生效，不是 66 节全量） |
| `POST /api/ingest` 合法 | ✅ `{ok:true, accepted:2, rejected:[]}` |
| `POST /api/ingest` 混合批次 | ✅ `accepted:1`，3 条拒收**原因逐条具体** |
| `POST /api/ingest` 空数组 | ✅ 400 |
| **事件真的进库** | ✅ `/api/sessions` 出现 `dsh:sess-smoke`，**3 条消息** |

## Apply 任务

- [x] `docs/Web-API-Design.md`：补 §2.4.1 / §2.4.2（CLAUDE.md 硬约束：新增方法必须同步契约）
- [ ] `openspec/specs/dsh-adapter/spec.md`：把「双进程模型」从二期标记改为已落地
- [ ] `openspec/specs/index.md` 更新
- [ ] `docs/HANDOFF.md`

## 下二段（dsh 插件侧）—— ✅ 完成 2026-10-01

- [x] `src/alysia-client.ts`：HTTP 客户端（baseUrl + 超时 + **best-effort**）
      - **永不抛出**：连接被拒/超时/非 JSON/非 2xx 一律返回 `null`/`false` + 记日志
      - 失败降噪：连续失败只吼前 3 次（alysia 没起时每轮都失败，会把 dsh 日志淹掉）
      - HTTP 非 2xx 时**把响应体读出来**（只说「HTTP 400」等于没说）
- [x] `src/session-id.ts`：`DSH_SESSION_PREFIX` + `sessionIdOf` + `toAlysiaSessionId`
      - 前缀是**跨包契约**（server 的 `ingest.ts` 里也有一份）；漂移会**响亮失败**
        （server 对非该前缀一律拒收且原因具体），不是静默丢弃
- [x] `persona-variable.ts`：**缓存 + 后台刷新**（5 分钟）
      - provider 同步返回缓存；拿不到就保留旧值（**旧人设远好于 throw**）
      - 首次启动用静态文本兜底；`persona=native` 时不刷新（用不上）
- [x] `index.ts`：`turn/end` 批量回传 + `session/disposed` 先补发再触发结算
      - 去重键 `dsh-<sessionId>-<seq>`（重传不产生两条）
      - 失败**保留一批**等下次（容忍 alysia 短暂重启）；有上限，长期不可用丢最旧的并计数

### ★★ 实测抓出的一个真 bug（不查源码绝对发现不了）

`extractText` 原先读 **`data.content`** —— 那是**错的**。

从 dsh 源码 `dsh-agent-loop` 的事件构造点读到真实形状：

```js
session.append('assistant/message', { turn, step, message: createAssistantMessage(...) })
                                                              ↑ 文本在 message 下面
```

正确路径是 **`data.message.content`**（块为 `{type:'text', text}`）。

**后果**：每条消息都取到空串 → 队列永远为空 → **回传静默变成「一条都没发」**，
而且连一条日志都不会有（空批次直接 return）。属于本项目最怕的「成功日志掩盖了没做的事」。

已修，并把测试 fixture 换成实测形状——退回旧写法测试会立刻红。

### 验证

| 项 | 结果 |
|---|---|
| adapter 测试 | ✅ **55 passed**（4 文件：client 17 / persona-variable 8 / index 17 / patch 13） |
| 常规全仓 | ✅ **883 passed** |
| 事件形状 | ✅ 取自 dsh 源码实测（非推测），fixture 同步 |
| **alysia 不可达** | ✅ 有专门用例：不抛 + 事件暂存 + 恢复后补发 |

### ⚠️ 仍未验的（如实说明）

**在真 dsh 里跑一轮完整会话**——需要真开一个会话，CLI 驱动不了 dsh 的 API。
已验证的到此为止：通道（curl 实测）+ 插件逻辑（55 单测，含真实事件形状）+
组合与激活（`--dump-config` + 真启动无 `did not activate`）。
**唯一没走通的**是「真会话 → 真回传」。

## 遗留 / 未决

- **人设 6375 字**：dsh 每轮都会带上，是笔固定 context 开销。
  要不要更短的 dsh 专用人设（比如 2 节）留待观察实际体验后再定。
- **回传时机与批量**：本段只做通道，dsh 侧怎么攒、多频繁回传（每条即传？轮结束？会话结束？）
  在下一段定。倾向「轮结束批量 + 会话结束兜底」。

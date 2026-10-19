# Change Proposal: fix-session-end-window

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-11
- **类型**: FIX（修 bug）
- **状态**: **archived**（2026-10-11 部署上线，镜像 `61504c37565d`；线上实测窗口 4.8h / mc=2）
- **影响 spec**: `memory-system`（§3.3 三层处理时机 / §2.4 Conversation Store）

## 动机（为什么做）

### 现象（2026-10-11 线上库实测）

主线 QQ 会话 `qq-official-1:private:private_<OWNER_OPENID>（已脱敏）`
（199 条摘要、累计 41894 条消息事件）：

| 指标 | 实测值 |
|---|---|
| 窗口跨度 > 24h 的会话数 | **153 / 202（76%）** |
| 窗口跨度 > 24h 的会话占用的消息事件 | **41731 / 41923（99.5%）** |
| `message_count` 恰好 = 1000 的会话 | **29 条** |
| 这 29 条的窗口跨度 | **1106 ~ 1456 小时（46 ~ 61 天）** |
| 这 29 条的 `started_at` | 全部落在 2026-08-15 ~ 08-21 |
| 对照组（正常会话） | 跨度 **4.1 ~ 5.4 小时**，`message_count` 1~7 |

```
2026-10-07T08:21:30Z  started=2026-08-21T10:25Z  跨度=1126h  mc=1000
2026-10-04T13:33:55Z  started=2026-08-19T06:38Z  跨度=1111h  mc=1000
```

同一段历史被反复摘要：10-03 `12:10:00` / `12:10:45` / `12:11:24` 三条，
**间隔 45 秒**，`started_at` 全部是 8-17 04:32~04:34。模型的摘要正文自己写着
「**这是一段跨越数日的长篇日常对话**」——它拿到的确实不是「这段会话」。

### 根因

`MemoryManager` 有**三个** SessionEnd 入口，**两个漏了窗口锚点**：

| 入口 | 代码 | 是否传 `since` |
|---|---|---|
| `archiveStaleSessions`（cron 每 6h） | `MemoryManager.ts:1083-1085` | ✅ `anchor = getLatestBySession(sid)?.ended_at` |
| **`onSessionEnd`**（聊天中 `usage.input > 8000` 触发） | `MemoryManager.ts:1052` | ❌ **不传** |
| **`extractProfile`**（Web 端「提取画像」按钮） | `MemoryManager.ts:1220` | ❌ **不传** |

`process(sessionId)` 不传 `since` → `EventStore.getBySession(sessionId, {})`
（`EventStore.ts:90` 缺省 `limit=1000`、无窗口条件）→
**取该会话全历史最近的 1000 条事件**。

触发链路：

```
packages/core/src/pipeline/stages/llm-agent.ts:270
  if (usage.input > 8_000) this.ctx.memoryManager.onSessionEnd(...)   // 每次聊天回合判一次
    → MemoryManager.onSessionEnd(sessionId)                            // :1048
      → sessionEndProcessor.process(sessionId)                         // :1052  没有 since
        → eventStore.getBySession(sessionId, {})                       // 全历史 DESC LIMIT 1000
```

### 后果（全部有日志/库证据）

1. **摘要质量**：8 天里 `[SessionEnd]` 报 **10 次「LLM 返回空响应」+ 4 次 `truncated=true`**，
   4 次最终落 `summary_status='failed'`（10-04 ×2、10-07、10-10）。
   1000 条消息的 prompt 是这个槽**唯一被观测到的失败场景**。
2. **成本**：每次 `onSessionEnd` 耗时 **19 ~ 35 秒**
   （27128ms / 34538ms / 30063ms / 35721ms / 27296ms / 23877ms / 30627ms / 19214ms / 33746ms），
   cron 正常路径只要 ~6s。8 天触发 9 次（10-04 一天 6 次）。
3. **正反馈**：这些横跨 47 天的重复摘要经 `ConversationStore.getRecent()`
   （按 `started_at DESC`）**注回 prompt** → prompt 膨胀 → `usage.input > 8000`
   更易命中 → 再摘一次。
4. **画像重复提取**：`process()` 第 4 步会对同一个 1000 条窗口反复跑
   `ProfileExtractor.extract`（同一天 6 次 = 6 倍提取成本）。

## 需求（做什么）

- [ ] `MemoryManager` 抽出**唯一的锚点规则**（私有 helper）：
      锚点 = `conversationStore.getLatestBySession(sessionId)?.ended_at`；
      无摘要 → 回退 24h 前
- [ ] `onSessionEnd` 用该锚点（`:1052`）
- [ ] `extractProfile` 用该锚点（`:1220`）
- [ ] `archiveStaleSessions` **改用同一个 helper**（行为不变，消除三处各写一遍）
- [ ] 回归测试：锚点之前的旧事件**不得**进本次窗口

## 设计决策（怎么做，含备选与取舍）

1. **修在调用方，不改 `process()` 签名。**
   `SessionEndProcessor.process(sessionId, since?)` 从 9-26 起就支持 `since`
   并已把它下推到 SQL（`EventStore.getBySession` 的 `since`/`until`）。
   缺的是**调用方没传**，不是能力缺失。

2. **抽 helper 而不是在三处各抄一遍。**
   本次故障的本质就是「同一个规则写了两遍、漏了第三遍」。
   留三份副本 = 下次新增入口继续漏。helper 是唯一的规则入口。

3. **锚点语义选 `getLatestBySession().ended_at`，与 cron 现状一致。**
   备选方案「按 `processed` 标记取未处理事件」被否决：
   `markProcessed` 只在成功后调用，失败窗口的事件会一直「未处理」，
   用它做锚点会让失败窗口**每次都被重新拉进来**，反而放大本 bug。

4. **不改 `llm-agent.ts:270` 的触发条件（`usage.input > 8000`）。**
   「上下文超阈值就调 SessionEnd」这个语义本身可疑（它不是压缩、也没防重入），
   但那是**另一个问题**，改了会混淆本 change 的验证口径。记录在「刻意不做」。

## 对账方向确认

- [x] **gap 方向 = doc 没声明、impl 有 bug → 补 spec + 改 impl。**
  `memory-system` §3.3 只描述了 **cron 路径**的锚点（`getLatestBySession`），
  从未声明 `onSessionEnd` / `extractProfile` 可以不带锚点。
  本 change 补上「三个入口共用同一锚点」的契约，**不放松任何既有条款**。
- [x] 涉及 Web API？`extractProfile` 是 Web 端「提取画像」按钮的后端。
      **方法签名与返回结构不变**（仍 `{ factsExtracted, summaryGenerated }`），
      只修内部窗口。`docs/Web-API-Design.md` **需补一句行为说明**（不改契约）。

## 测试计划

- `packages/core/tests/memory/session-end-window.test.ts`（新增）：
  - 会话有一条 `ended_at = T-1h` 的历史摘要；事件 2 条在 T-2h、1 条在 T-30m
    → `onSessionEnd` 后新摘要行的 `message_count === 1`（锚点前的不进窗口）
  - 无历史摘要 → 回退 24h：25h 前的事件不进、1h 前的进
  - `extractProfile` 同样受锚点约束
  - `archiveStaleSessions` 行为**不变**（重构后回归）
- 既有用例全绿：`pnpm --filter @alysia/core test -- --exclude='tests/memory/e2e/*'`
- 类型：`tsc --noEmit` 退出码 0

## 刻意不做（记录在案）

- ❌ **不改 `llm-agent.ts:270` 的 `usage.input > 8000` 触发条件**
  ——「聊天回合顺手触发会话摘要」的语义问题属独立 change
- ❌ **不动 `EventStore.getBySession` 的 `limit` 缺省 1000**
  —— 它是窗口内的**安全上限**，本身合理；问题在窗口没设
- ❌ **不清理线上已有的 29 条超长窗口摘要**
  —— 属数据回填，需独立 change + 备份锚点
- ❌ **不跑真实 API 探针**


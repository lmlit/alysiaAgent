# Tasks: add-memory-channel-field

> 用户 2026-10-16 明确「这个改」（加显式渠道字段）。三层（events / conversations / facts&hints）已完成。

## 已完成

### events / conversations 层

- [x] `packages/core/src/utils/channel.ts`（新）
      - `channelOfSession()`：`dsh:` → dsh、`qq*` → qq、`webui:` → webui、其余 → **unknown**
      - `isDshSubagentSession()`：主会话是 `dsh:session-<uuid>`，其余 `dsh:` 视为子会话
      - `MemoryChannel` 枚举：`qq | dsh | webui | life | system | unknown`
- [x] `database.ts`：`events.channel` / `conversations.channel`
      （`addColumnIfMissing` 探测式幂等，**不 DROP**；
      默认值取 **`''`**（还没回填）而不是 `'unknown'`（判不出来）——两者语义不同）
- [x] `database.ts`：**回填**（`WHERE channel = '' OR channel IS NULL`）
- [x] `EventStore.insert` / `ConversationStore.insert`：**写入时落库**
- [x] 类型：`MemoryEvent.channel?` / `Conversation.channel?`
- [x] 测试：`tests/memory/channel-field.test.ts`（**8 例**）

### facts / character_facts / adaptation_hints 层

- [x] `ProfileFact.channel?`（类型）
- [x] `ProfileExtractor.toFact`：`channel: channelOfSession(events[0]?.session_id)`
      （起源事件这里拿得到 ⇒ 如实派生；拿不到记 unknown）
      ★ `character_facts` 是 `{...toFact(f, i), source:'inferred'}` ⇒ **自动继承** channel
- [x] `PersonaAdapter`：
      - `apply(adj, options?: { bypassLimits?, channel? })` —— **穿参**，不默认成某个真实渠道
      - 两处 hint 写入点：普通调整记 `options.channel ?? 'unknown'`；`stale_regression` 记 `'system'`
      - `adjustFromMood`（生活事件驱动、无用户会话）→ `{ channel: 'life' }`
- [x] 两个**有事件上下文**的调用方把渠道传下去：
      `RealtimeProcessor`（实时扫描）、`SessionEndProcessor.confirmPersona`
- [x] 测试：`tests/memory/channel-field-facts-hints.test.ts`（**7 例**，含
      「`source` 与 `channel` 是不同的轴」（前者 user/behavior/inferred＝提取方式）与
      「情绪漂移必须记 `life` 而不是 `unknown`」）

## ★ 为什么把枚举扩到 `life` / `system`（而不是一律 unknown）

`apply()` 的三个来源：用户会话（qq/dsh/webui）、**生活事件驱动的情绪漂移**（没有用户会话）、
**系统发起的 24h 回归**（`stale_regression`，连事件都没有）。
若后两者都记 `unknown`，就把「**设计行为**」和「**判不出来的数据债**」混成了同一个值 ——
而这两者的处理策略完全相反（前者要保留，后者要回填或忽略）。

## ⏳ 未做：老数据的回填（R9）—— 而且**刻意**不放这儿

`facts` / `character_facts` / `adaptation_hints` 的**存量条目**还没有 `channel`。

**为什么不写在 `initializeDatabase` 里**：
1. 这三样是 **JSON 列**，回填要整列 parse + 重写 —— 每次启动都做一次不可接受；
2. 它是一次性**数据修复**，而数据修复应当**离线、可 dry-run、可核对**，不能藏在启动路径里
   （本仓反复栽在"启动时静默做了件事"这类设计上）；
3. 而且它**正好和合并是同一次操作**：合并（远端 QQ 库 + 本机 dsh 记忆）是
   **唯一一次能顺手补标**的机会 —— 新增的 dsh 条目就地打 `channel:'dsh'`，
   老条目按 `source_event` 形态（`dsh-*` / `ROBOT1.0_*`）能判的补，判不出记 `unknown`。
   ⇒ 放进 KI-20 的清理/合并工具（`scripts/ki20/*`，`--in/--out`，绝不原地改）。

## 验证记录

| 项 | 命令（workdir `packages/core`） | 结果 |
|---|---|---|
| 定向 | `run tests/memory/channel-field.test.ts` | **8 passed**（首跑即过） |
| 定向 | `run tests/memory/channel-field-facts-hints.test.ts` | **7 passed**（首跑即过） |
| core 全套 | `run --exclude='tests/memory/e2e/*'` | **83 files / 792 passed**（+2 文件 / +15 例） |
| 类型 | `npx tsc --noEmit` | exit 0 |

## 部署状态

**未部署。** 改 core（含一处迁移）与 spec。
⚠️ 迁移会在**下次启动**时作用于生产库（加两列 + 回填），只加列不 DROP。

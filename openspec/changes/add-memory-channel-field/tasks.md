# Tasks: add-memory-channel-field

> 用户 2026-10-16 明确：「这个改」（加显式渠道字段）。**未归档**——facts/hints 两层还没做。

## 已完成（events / conversations 层）

- [x] `packages/core/src/utils/channel.ts`（新）
      - `channelOfSession()`：`dsh:` → dsh、`qq*` → qq、`webui:` → webui、其余 → **unknown**
      - `isDshSubagentSession()`：主会话是 `dsh:session-<uuid>`，其余 `dsh:` 视为子会话
        （子会话是独立来源，本仓有过专门的净化 change）
      - `MemoryChannel` 类型 + `isMemoryChannel()` 校验
- [x] `database.ts`：`events.channel` / `conversations.channel`
      （`addColumnIfMissing` 探测式幂等，**不 DROP**；
      ⚠️ 默认值取 **`''`** 而不是 `'unknown'` —— 前者表示"加列之前、还没回填"，后者表示"判不出来"，两者不同）
- [x] `database.ts`：**回填**（`WHERE channel = '' OR channel IS NULL`，只按前缀判得出来的填）
- [x] `EventStore.insert` / `ConversationStore.insert`：**写入时落库**
      （显式给了用给的，否则 `channelOfSession(session_id)`）
- [x] 类型：`MemoryEvent.channel?` / `Conversation.channel?`
- [x] 测试：`tests/memory/channel-field.test.ts`（**8 例全过**）

## 待做（facts / hints 层）—— 这是本 change 未完成的部分

- [ ] `user_profile.facts` 条目加 `channel`：写入点在画像提取（`ProfileExtractor` → facts 数组）
      ⚠️ 该数组元素字段现为
      `fact, confidence, evidence, source_event, updated_at, source, valid_from, valid_until, status, category`
      —— **`source` 是 `user`/`inferred`（提取方式），不要动它的语义**，另加 `channel`
- [ ] `user_profile.character_facts` 同上（`ProfileExtractor` 的 character facts 路径）
- [ ] `persona.adaptation_hints` 条目加 `channel`（写入点在 `PersonaAdapter`）
- [ ] 三者的**老数据回填**：能从头 `source_event` 形态（`dsh-*` / `ROBOT1.0_*`）判定的补标，
      判不出记 `unknown`——**不许猜**（且本仓有契约：`source_event` 会造合成 id 如 `reflection-<日期>`，不可溯源）
- [ ] 三者的测试

## ⚠️ 为什么待做部分不能拖到"合并之后"

合并（远端 QQ 库 + 本机 dsh 记忆）那一步，正是**唯一一次能顺手补标**的机会：
合并时新增的 dsh 条目可以就地打上 `channel:'dsh'`；等合并完再回头补，老条目就只能标 `unknown`。

## 验证记录

| 项 | 命令（workdir `packages/core`） | 结果 |
|---|---|---|
| 定向 | `run tests/memory/channel-field.test.ts` | **8 passed**（首跑即过） |
| core 全套 | `run --exclude='tests/memory/e2e/*'` | **82 files / 785 passed**（+1 文件 / +8 例） |
| 类型 | `npx tsc --noEmit` | exit 0 |

## 部署状态

**未部署。** 改的是 core（含一处迁移）与 spec ——
⚠️ 迁移会在**下次启动**时作用于生产库（加两列 + 回填），属于向后兼容的加列，不 DROP 任何东西。

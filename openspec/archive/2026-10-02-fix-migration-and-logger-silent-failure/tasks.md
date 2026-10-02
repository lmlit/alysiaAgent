# Tasks: fix-migration-and-logger-silent-failure

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## database.ts —— 迁移不留裸 catch

- [x] 抽 `addColumnIfMissing(db, table, column, ddl)`：先 `PRAGMA table_info` 探测，
      列已在 → 跳过；否则执行，**失败原样抛出**
- [x] 13 处裸 catch 迁移到该 helper（DDL 字符串、顺序**逐字保留**）：
      `persona.memory_config` / `worldbook_entries.digest` / `user_profile.character_facts` /
      `events.perspective` / `conversations.character_perspective` / `conversations.summary_status` /
      `ai_life_state.mood_value` / `ai_life_events.origin` / `ai_life_intents.evidence` /
      `ai_life_intents.defer_count` / `ai_life_state.mood_note` / `persona.overlay_notes` /
      `ai_life_state.reflection`
- [x] 顺手改掉 4 处**已过时**的注释（还写着「ALTER + try-catch」——现在不是了）

## utils/logger.ts —— 日志子系统自身失败要能喊

- [x] `writeFileLine` 失败 → `console.error` **喊一次**（`fileWriteFailed` 标志位防刷屏；
      **不调 logger 自己**，会无限递归）；成功写入后复位标志位
- [x] `configure` 的 `mkdirSync` 失败 → 同样喊（"日志目录建不出来 = 文件持久化从未生效"）
- [x] `cleanupOldLogs` 的裸 catch → 同样喊（清理失效会让磁盘被日志慢慢吃满）

## 测试

- [x] `tests/memory/unit/database.test.ts`：重复初始化幂等（第二次不抛、列仍齐全）
- [x] 同文件：`addColumnIfMissing` 列不存在时加上 / 已存在时空操作不抛
- [x] 同文件：**迁移真失败 → 原样抛出**（旧写法这里会静默通过）
- [x] 同文件：表结构不对不会被误判为幂等跳过（探测的是真实结构，不是"猜"）
- [x] `tests/utils/logger.test.ts`：日志目录建不出来 → `console.error` **恰好一次**（不刷屏）

## 文档

- [x] `docs/KNOWN-ISSUES.md` KI-5 重写：存储层裸 catch **已清点完**（✅ 已修 2 项 / ⬜ 未修 9 项清单）
- [x] `docs/KNOWN-ISSUES.md` 新增 **KI-11～KI-17**：本次审计未纳入的大件
      （`.changes` 不检查 / `INSERT OR REPLACE` 列单 / 知识库半截文档 /
      `LanceDBStore.insert` 永不抛 → 上游 catch 死代码 / `vectorStore` null 静默跳过 /
      `PersonaStore` 读时回写默认值 / `summary_status` 默认 ok）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`（**新增 §4.7**；
      注意 §4 已有 4.1～4.6）
- [x] 更新 `openspec/specs/index.md`（memory-system 行的「最后变更」）
- [x] 运行 `pnpm --filter @alysia/core test` + `pnpm --filter @alysia/server test`
- [x] core 改动**必须 build**（`cd packages/core && npm run build`）——server 走 dist
- [x] 核 dist 产物含新代码
- [x] 更新 `docs/HANDOFF.md`
- [x] 归档 + 更新索引

## 验收结果（2026-10-02）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **618 passed / 63 files**（+6：database 3→7、logger 2→3 等） |
| server 单测 | ✅ **223 passed / 13 files**（无回归） |
| core / server `tsc --noEmit` | ✅ 均退出码 0 |
| `core` build | ✅ 退出码 0；**已核 dist 产物**：`dist/memory/database.js` 有 `addColumnIfMissing`（13 处调用）、`dist/utils/logger.js` 有两处 `shoutOnce` |
| `database.ts` 残留裸 catch | ✅ **0 处**（`grep catch` 只剩注释里的字面提及） |
| 迁移行为 | ✅ DDL 字符串与顺序**逐字未变**（只换了幂等的实现方式） |

## ★ 刻意不做（记录在案）

- ❌ **不修其余裸 catch**（`CronProcessor:99` / `PromptAssembler:158` / `PersonaStore:33` /
  `LanceDBStore:59,96,160` / `MemoryManager:197` 等 9 处）——**已全部登记 KI-5**，留第二刀
- ❌ **不给裸 catch "加日志"** —— 迁移那 13 处是**去掉** catch（探测式不需要它）；
  加日志会让每次启动刷 13 行噪声，且"列已存在"根本不是错误
- ❌ **不动 `.changes` 检查**（KI-11）——**口径未定**：幂等跳过（`INSERT OR IGNORE`）为 0
  是正常的，一刀切会把正常路径变成噪声。要先定规则再改
- ❌ **不做事务化改造**（KI-13 知识库半截文档）——属结构性改动，独立 change

## 下一步（第二刀，不在本 change 内）

`fix-store-write-trace`，建议顺序：
1. **先定 `.changes` 口径**（KI-11）——哪些写点必须检查、哪些显式豁免
2. `LanceDBStore.insert/delete` 的失败语义（KI-14）——rethrow 还是返回标记，让调用方能判
3. `vectorStore` null 的逐次可区分降级（KI-15），**尤其 `SessionEndProcessor:160` 的计数只数摘要**
4. 把 KI-5 那 9 处裸 catch 按本 change 同一手法收拾掉

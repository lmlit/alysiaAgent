# Tasks: fix-store-write-trace

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 实现走执行工具（subagent-driven-development / TDD），本文件只记账。

## 范围声明

本 change 收录 7 项（KI-12 / KI-13 / KI-14 / KI-15 / KI-16 / KI-17 / KI-5 剩余 9 处）。
**已完成：全部 7 项**（2026-10-16）。KI-5 的 9 处里 **8 处已销**，
剩 1 处（`server/src/life.ts` 的 `tick` catch）**只是日志粒度粗、并非静默吞错**，见文末。

---

## KI-12 —— `EventStore.insert` 不再 `INSERT OR REPLACE`（Event Log 不可变）

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/unit/EventStore.test.ts`
      新增 describe「KI-12 同 id 重投不可变语义」
- [x] 复现确认**红**：修前 4 failed / 16 passed（失败信息见文末验收表）
- [x] `insert()` 改三分支：**同 id 同内容 → 幂等空转**（不碰 `archived` / `processed` /
      `importance` / `created_at`，任何列都不改）
- [x] **同 id 不同内容 → 不覆盖**，保留原有事件 + `logger.warn` 响亮报冲突
      （消息含事件 id、会话 id、双方 payload 摘要）
- [x] **新 id → 正常插入**（列单与旧实现逐字一致；`archived` 走表默认 0）
- [x] 去掉 `INSERT OR REPLACE`（改为纯 `INSERT`）——主键冲突会抛 `SQLITE_CONSTRAINT`（响亮）
- [x] payload 比较前**归一化**：递归按键名排序（数组保序）。
      ⚠️ 提示里的 `JSON.stringify(JSON.parse(raw))` **不排序**，实测会误报冲突，故改为 canonicalize
- [x] 保持 `insert(event: MemoryEvent): void` **签名不变**（未扩大改动面）
- [x] 未引入事务：单进程 + WAL + better-sqlite3 同步 API，SELECT 与 INSERT 不会被事件循环交叠；
      即便有并发写者，主键也会让第二个 INSERT 抛错而非静默覆盖（理由已写进代码注释）

## KI-14 —— 向量写入/删除失败必须让调用方能判

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/unit/LanceDBStore.test.ts`（新文件）
- [x] 复现确认**红**：6 failed / 1 passed —— 失败信息是 `promise resolved "undefined"`,
      `"[]"`, `"+0"` **instead of rejecting**（正是 KI-14 的诊断原文）
- [x] 新增 `VectorStoreUnavailableError`：把「库不可用」与「单次操作失败」区分开
- [x] `ensureReady()` → `requireReady()`：不可用**抛**，不再 `return false` 让各方法静默降级
- [x] `insert` / `delete` / `search` / `count` 四个方法：**log warn + rethrow**
      - `search` 的 `[]` 现在只表示「确实没有匹配」；`count` 的 `0` 只表示「库真的是空的」
- [x] upsert 的**前置 delete** 失败：不抛（LanceDB 在「谓词没匹配到」时是否抛无法在本仓证实，
      抛了会把每次正常写入变成失败），但**必须留痕** —— 它会造成同 id 重复行（KI-5 那条）
- [x] 接口契约写进 `IVectorStore.ts`（失败必须报出来；降级是**调用方**的决定）
- [x] 确认 KI-14 点名的「死代码复活」：`MemoryManager:291/1466` 的 `Promise.allSettled` 计数
      与 `:543` 的 `.catch` 现在**第一次真正会触发**（此前 `failed` 恒为 0）
- [x] 测试：正常路径回归（写入/删除/计数成功、`search` 空结果仍是 `[]`）

## KI-15 —— `vectorStore` 为 null 时的降级必须**逐次可区分**

- [x] 先写复现测试：`packages/core/tests/memory/unit/ConversationStore-vector.test.ts`（新文件）
- [x] `ConversationStore.insert` / `updateSummaryResult` 返回 `VectorWriteOutcome`
      （`stored` / `no-store` / `no-vector` / `failed`），失败**不拖垮已写好的摘要行**
- [x] `SessionEndResult` 新增 `vectorOutcome`：**摘要与向量分开记账**
      （KI-15 点名「最危险」的 `if (ok && this.vectorStore)` 就是这里 —— 计数只数摘要）
- [x] `MemoryManager.archiveStaleSessions` 的日志加向量总账：
      `archived N/M …（向量：成功 X / 无库 Y / 失败 Z）`，**全部 stored 才不加尾巴**
- [x] `RealtimeProcessor`：无向量库时不再静默 —— 首次必报 + 每 100 条补报累计
- [x] `MemoryManager.importKnowledge`：末尾报「N/M 个 chunk 只进了文本检索」
- [x] `SessionEndProcessor.applyImportantMoments`：末尾报「N 条的向量 metadata 未刷新」
      （importance 写进了 events 表，但**召回读的是向量** —— 不刷新等于不生效）
- [x] 顺带修 §5.5.3 要求的裸 catch：`process()` 的 embed 失败原本是 `catch {}`，改为 warn
- [x] 测试：四态各自覆盖（store 层 + 处理器层），并锁住
      「向量失败**不**把 `summary_status` 改成 failed」（两本账互不冒充）

## KI-16 —— 读时兜底**不得回写**默认值

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/unit/PersonaStore-read.test.ts`（新文件）
- [x] 复现确认**红**：`读操作把默认值写回库了 ⇒ 「被冲空」被伪装成「出厂默认」`
      （`expected '{"formality":0,…}' to be '{}'`）
- [x] 新增私有 `withDefaults(row)`：把空的 tone / speech_style / emotional_range
      **只填进返回值**，一个列都不写库
- [x] `ensureRow()` **删掉**原来的「检测到空列就 UPDATE 回默认值」那一段
      —— 它把「人格被冲成空」整形成与 seed **逐字相同**的合法默认值，骗过数据层也骗过巡检
- [x] 新增**显式**入口 `repairEmptyColumns()`：真的写库，**并 warn 出被修的列名**
      （兜底只在内存生效的话，「库里其实是空的」就永远没人说）
- [x] 启动期接线：`al:persona-seed` 调 `MemoryManager.repairPersonaDefaults()`，非空则 warn
- [x] **顺带销 KI-5 两条**：`migrateMemoryConfig()` 的裸 catch（`PersonaStore:33`）
      通过**删掉整个方法**解决 —— 它是**写探针**（每次读都 ALTER TABLE），
      而同一列的迁移早已在 `initializeDatabase()` 里集中做过（探测式 `addColumnIfMissing`）；
      全仓 `grep` 确认除 `get()` 外无调用方
- [x] 测试：三个列全空一次读完 → 库里三列一个都没动；读操作不改 `updated_at`（回归守卫）；
      显式修复会写库 + 留痕；无需修复时是空操作

> ⚠️ **公开面变化（披露）**：`PersonaStore.migrateMemoryConfig()` **已删除**
> （全仓无其他调用方）；新增 `PersonaStore.repairEmptyColumns()` 与
> `MemoryManager.repairPersonaDefaults()`。后者是**启动期修复**入口，
> Web 端**不需要**也不应调它，故未登记进 `docs/Web-API-Design.md`
> （该文档收录的是 Web 需要的读/写方法）。

## KI-17 —— 默认值与成功状态

- [x] 先写复现测试（红）：`conversation-summary-status.test.ts` 里那条
      **`默认写入 ok`** —— 测试本身编码了这个不安全的默认值
- [x] 复现确认**红**：`expected 'ok' to be 'failed'`（两个点各一条）
- [x] `ConversationStore.insert`：`summary_status ?? 'ok'` → **`?? 'failed'`**
      （漏传状态的路径必须"可见且可补"：`getRecent()` 不再注入空摘要、
      `retryFailedSummaries()` 会把它捞出来）
- [x] `rowToConv`：NULL → **`'failed'`**。⚠️ 已核实**实际不会出现 NULL**——
      该列是 `ALTER TABLE … ADD COLUMN … DEFAULT 'ok'` 加的（SQLite 用默认值回填存量行），
      所以这条改动**零迁移风险**，纯粹是「万一有 NULL 就宁可多补一次」
- [x] `updateSummaryResult` 返回值改为 **`{ rows, vector }`**：0 行 = 目标行不存在
      ⇒ **不是成功**（旧实现照打「补处理成功」+ `return true`）
- [x] `retryFailedSummary`：`rows === 0` → **`return false`** + 明确 warn，不再宣布成功
- [x] 测试：默认写入 failed / 显式 ok 仍 ok / NULL 读作 failed /
      `updateSummaryResult` 命中不存在的行 → `rows: 0` / **`retryFailedSummary` rows=0 → false 且无「补处理成功」**（后两条是新增覆盖）
- [x] ⚠️ 连带更新 fixture：`c-ok` 一类「健康摘要」的行必须**显式** `summary_status: 'ok'`，
      否则会被 `getRecent` / `searchByText` 排除（这正是本次默认值改动的语义后果）

## KI-13 —— 知识导入：事务化 + 重试路径校验完整性

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/knowledge-import.test.ts`（新文件）
- [x] 复现确认**红**：`留下了伪装完整的文档壳: expected 1 to be +0`（主症）
      与残行场景 `expected true to be false`
      ★ 用 **SQLite 触发器**（`RAISE(ABORT)`）制造**确定性**的「第 N 块写失败」——
      比 mock 更接近真实失败（真在 INSERT 上炸），且可精确控制炸在哪一片
- [x] `KnowledgeStore.insertDocWithChunks(doc, chunks)`：doc 与**全部 chunk 在同一事务里**写
      （`db.transaction()`，抛错即整体回滚 ⇒ **残壳不可能存在**）
- [x] `chunk_count` 改用**实到块数**：doc 传入 `chunk_count: 0` 占位，
      由事务内真正 INSERT 成功的条数回填（**不许先声明一个尚未兑现的块数**）
- [x] `importKnowledge` 的 hash 去重**校验完整性**：命中后核对
      ① `status === 'active'`（归档的不算已导入）② `实际 chunk 数 > 0 且 === chunk_count`；
      不完整则 **warn + 清掉残壳 + 重新导入**（docId 由 hash 决定 ⇒ 向量 id 不变，重建即覆盖）
- [x] 返回值 `chunks` 改用 `storedChunks`（事务的实到数），不再直接回 `chunks.length`
- [x] 向量化**留在事务外**（另一条链路、失败不阻塞文本检索，KI-15 已覆盖）
- [x] 测试：中途失败后库里 0 doc / 0 chunk；撤掉触发器重试能完成且块数如实；
      残行 `chunk_count=99` 不被当成事实；**完整**的重复导入仍 `deduplicated: true`（不误伤去重）；
      归档后的文档重新导入会重建

## KI-5 剩余 —— 裸 catch（**含一处落点更正**）

- [x] 先给热路径加限频工具：`warnThrottled(tag, msg, limit=3)`（`utils/write-trace.ts`）
      —— KI-5 的方向是「至少喊一次」，但有些点在**每轮对话**上跑，每次都喊会把日志淹掉
      （本项目刚因日志被淹吃过亏：`add-ops-health-report` 的前置就是「96.6% 是 QQ 噪声」）
- [x] `CronProcessor` 知识库归档失败 → warn（旧：裸 catch ⇒「一个都没归档」与「没有要归档的」同形）
- [x] `PromptAssembler` `[关于我]` 块构建失败 → warn（限频）
- [x] `PromptAssembler` `[待确认的事实]` 块构建失败 → warn（限频）。
      ★ 这处正是 KI-5 点名的那个 —— 它内部会跑 `expireStaleFacts()` → `writeFacts()`，
      所以吞掉的可能是**写**失败（过期事实永不清理）
- [x] `LanceDBStore` 的 `openTable` 失败 → 把**真原因**带出来
      （旧：裸 catch ⇒ 所有失败都被当成"表不存在"，后面那句 warn 的报错是**误导性的**）
- [x] `MemoryManager.loadTokenStats` / `saveTokenStats` → warn
      （旧：裸 catch ⇒「文件坏了」与「从来没有过统计」在 `/api/stats` 上同形）
- [x] `MemoryManager.getLifeContinuityBlock` → warn（限频）
- [x] **★ KI-5 落点更正**：`MemoryManager.getWorldviewBlock` 那条**描述不成立** ——
      ① `readWorldviewBlock()` 自己就有裸 catch、**永不抛**，所以 MemoryManager 那个 catch 是**死代码**；
      ② 旧代码 `catch { this._worldviewBlock = '' }` 里 `''` 是 **falsy** ⇒ 下次调用仍会重试，
      **并没有「永久缓存成空」**。
      真正的静默吞错在 **`persona/loader.ts` 的三个读函数**
      （`readPersonaFile` / `readWorldviewBlock` / `readWorldbookFile`）——
      「`soul.md` 读不到」与「文件本来就是空的」**完全同形**，
      而**人格核心静默缺失**正是本项目栽过的事故类型。已全部补 warn（按文件名限频）。
      ★ 这 13 个文件都随包发布（已核实），所以任何读失败都是**真问题**，不是可选文件缺失。
- [x] 测试：`persona-loader-warn.test.ts`（mock `fs` 让 `worldview.md` 读失败 →
      断言**有 warn、带真原因 EACCES、限频 ≤3、正常文件不误报**）+ `read-failures-visible.test.ts`
- [ ] **仍未做**：`packages/server/src/life.ts` 的 `tick` catch。
      ★ **已核对机制**（不是"记了 error 就算完"）：`tick()` 是**一条线性链** ——
      每日摘要 → 每日反思 → 亲密度 → 意图到期扫描 → 对话余波 → 事件生成；
      任一阶段抛出即**中断后续全部**，而外层 catch 只打 `[Life] tick:`，**不说是哪一阶段**。
      ⇒ 后果正是 KI-5 写的那句：「生成失败 / 存储失败 / 推送未发生混在同一条，
      日志上像是这一轮什么都没发生」，**且后半段阶段静默没跑**。
      **它属行为问题（阶段隔离）而非吞错**：修它要给每个阶段各自 try/catch + 阶段标签，
      这会改变「一个阶段失败是否阻断其余」的语义 —— 属**行为变更**，
      宜与 `add-ops-health-report`（正确性指标）一起做并单独验证。**本次刻意未动。**

## 测试

KI-12 部分见下方验收表第一块。KI-14 / KI-15 的用例：

- [x] `LanceDBStore`：insert / delete / search / count 失败各自 **reject**（7 例）
- [x] `LanceDBStore`：库不可用 → 四个方法都 reject；upsert 前置删失败 → 有 warn（2 例）
- [x] `ConversationStore`：四态 + 摘要行不丢 + `summary_status` 不被污染（6 例）
- [x] `SessionEndProcessor`：`vectorOutcome` 四态 + store 违约时按 `failed`（6 例）
- [x] `grep` 检查 events 表是否还有别的 `INSERT OR REPLACE` 写入点 → **没有**
      （全仓 `INTO events` 只命中 `EventStore.insert`）

## 文档 / 治理

- [x] 新建本 `tasks.md`
- [x] `proposal.md` 的 KI-12 / KI-14 / KI-15 行标注完成（其余 KI 行未动）
- [x] 代码注释记录各条的现象链与取舍
- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`（§4.7 **新增契约 4～10**；
      合并记录见本 change 的 `spec.md`）
- [x] 更新 `openspec/specs/index.md`（memory-system 行「最后变更」+ 本 change 移出 Backlog）
- [x] 运行测试验证（core 73 files / 705 passed；server 227；dsh-adapter 100）
- [x] 归档
- [x] 另立 change：**KI-20** → `filter-synthetic-context-inflow`（**只立案，未实现**：
      它的第一项是取证，结论可能让实现项作废）

> ⚠️ Apply 项**故意留空**：本 change 还有 KI-13 / KI-16 / KI-17 / KI-5 剩余未做，
> 达不到 archive 的条件。§4.7 的契约整段合并留到那时做，避免同一节反复改两遍。

## 验收结果（2026-10-16）

| 项 | 结果 |
|---|---|
| KI-12 修前（红） | `tests/memory/unit/EventStore.test.ts` → **4 failed / 16 passed** |
| KI-12 修后（绿） | 同文件 → **20 passed（1 file）** |
| KI-14 修前（红） | `tests/memory/unit/LanceDBStore.test.ts` → **6 failed / 1 passed** |
| KI-14/15 修后（绿） | 新增两个文件合计 → **19 passed** |
| core 全套 | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run --exclude='tests/memory/e2e/*'`（`packages/core`）→ **73 files / 705 passed**（本 change 前基线 654，累计 +51） |
| server 回归 | `npx vitest run`（`packages/server`）→ **13 files / 227 passed** |
| dsh-adapter 回归 | `npx vitest run`（`packages/dsh-adapter`）→ **6 files / 100 passed** |
| `tsc --noEmit`（core） | exit 0 |
| events 表残留 `INSERT OR REPLACE` | ✅ **0 处** |
| `insert` 签名 | ✅ 未变 |

**行为变更披露**（会「点亮」此前永不触发的日志，属预期）：

1. `LanceDBStore` 四个方法现在会**抛** ⇒ 上游 try/catch 从死代码**复活**。
   `fix-store-write-trace` 的 proposal 已预告这一点（「那些是死代码复活，属预期」）。
2. `SessionEndResult` 多了 `vectorOutcome` ⇒ 3 个测试的 `toEqual` 整对象断言改为
   `toMatchObject`（它们只关心 `summarized` / `reason`，向量那本账由新文件覆盖）。
3. `ConversationStore.insert` / `updateSummaryResult` 返回值由 `void` 改成
   `VectorWriteOutcome`（生产调用方只有 `SessionEndProcessor`，已同步）。

## 刻意不做（记录在案）

- ❌ **`server/src/life.ts` 的 `tick` catch 未动**：它**记了 error**，只是**粒度太粗**
  （生成失败/存储失败/推送未发生混在同一条）。属**日志结构**问题，不是静默吞错，
  拆它要重新划分 tick 的三个阶段，宜与 `add-ops-health-report` 一起做。
- ❌ **`PromptAssembler` 另两处 catch 未动**（`:253` 非 JSON basics → 当摘要片段；
  `:341` 非 JSON → 当纯文本）：它们**不是失败**，是有意的语义回退，改了才是 bug。
- ❌ **读路径的 `[]` 降级未改**：`EventStore` / `ConversationStore` / `KnowledgeStore` 的
  `searchByVector` 在 `vectorStore === null` 时返回 `[]`。这是**已知降级**，且
  `MemoryManager.read` 已在 `!this.vectorStore` 时**提前分流**到文本检索，
  所以那三处的 `[]` 只在直接调用时出现。改它们要动读路径契约 —— 留作后续。
- ❌ **`ProfileStore.migrateFact` 未改**（KI-16 列为「同族」，核查后**不属同一缺陷**）：
  它是**纯函数**，只在读时补进内存对象，**不写库**；
  「回写存量」发生在 `writeFacts()` —— 那是显式写入路径的 JSON blob 整体重写
  （该列是 `TEXT` 存 JSON 数组，设计使然）。要消除它得改存储结构，不属本次范围。
- ❌ **不改 `database.ts` schema、不动其他 store**（硬约束）
- 📌 已知：`INSERT OR REPLACE` 在 **events 表之外**仍有同源用法（`LifeStore` 4 处、
  `KnowledgeStore` 1 处），**本次未动**，仅记录：

  | 位置 | 表 |
  |---|---|
  | `LifeStore.ts:87` | `ai_life_events` |
  | `LifeStore.ts:116` | `ai_life_daily_summaries` |
  | `LifeStore.ts:133` | `life_templates` |
  | `LifeStore.ts:218` | `ai_life_intents` |
  | `KnowledgeStore.ts:81` | `knowledge_chunks` |

  （这些表的语义与 Event Log 不同——`upsert` 是设计意图，不属于 KI-12。）

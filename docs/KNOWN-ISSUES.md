# 已知缺陷登记册

> 建立于 2026-10-01。**定位是 triage 入口，不是 spec。**
>
> **规则**（防止它退化成影子文档）：
> 1. 登记的是**已被证据坐实、但当前不修**的缺陷。不是猜测、不是愿望清单。
> 2. 每条必须有 **现象 / 证据（文件:行号或实测输出） / 影响 / 建议方向**。
> 3. **修一条 = 开正式 OpenSpec change**，修完把这里那行改成指向 change，归档时删除。
> 4. 与 `openspec/specs/index.md` 的 📌 Backlog 分工：
>    Backlog 收「doc 已声明、impl 未接」的 gap；本表收**缺陷**（行为不对，与 doc 无关）。
> 5. **不许把它当借口拖延**——P0/P1 级别的东西直接修，别登记。
>
> 严重度：🔴 线上有实际影响 / 🟠 潜在同源风险 / 🟡 技术债

---

## 🟠 推理预算类（2026-10-01 `fix-profile-extract-empty-response` 的同源未爆弹）

> 背景：`CHAT_MODEL` 是推理模型，**可见内容与 reasoning 共用同一个 `max_tokens`**。
> 该机制已造成 **3 次线上事故**（会话摘要 22 天 100% 失败 / 每日反思 11 次空响应 / 画像提取
> 静默停摆 6 个月）。下面这些槽位**没有被那次修复覆盖**，且从未实测过。
> 详见 `openspec/specs/memory-system/spec.md` §4.1.1。

### KI-1 🟠 `life.generateEvent` 槽没有 `max_tokens`

> ★ **2026-10-02 更新（change: `add-llm-budget-observability`）**：**观测手段已就绪，待采数据。**
> 此前这条无法判定，根因是**证据拿不到**，不是"没发生"：
> 1. `finish_reason` / `reasoning_tokens` **从未被解析**——provider 只取 message 与总 tokens；
> 2. `role: 'err'`（网络/超时/HTTP 报错）在 `modules/life.ts` 回调里被压成空串，
>    最终日志统一显示 `empty response` → **网络故障伪装成「模型没输出」**。
>
> 两处都已修好，判定入口：
> - `[LLM] <model> → … tokens=… finish=<x> reasoning=<n|?> (…)` —— **聊天链路**的槽位
> - `[LLM:memory] <model> → … tokens=… finish=… reasoning=…` —— **记忆链路**
>   （会话摘要 / 画像提取 / cron 深度重写 / 人格调整）★ **2026-10-11 补**
>   （change: `instrument-memory-llm`）。⚠️ 这四类之前**一条日志都没有**——
>   §4.1.2 契约 2 那句「所有槽位都流经 provider 层」是错的，它们走
>   `modules/resources.ts` 的第二个客户端。**部署 HEAD 之前，摘要槽的失败根本采不到数。**
> - 空响应会单独 warn，并直接指出「预算耗尽」还是「不是预算问题」
> - `[Life] event LLM: finish=… tokens=… reasoning=… content=N字 (…)` —— 事件槽位级现场
>
> **若手边日志里没有任何 `[LLM:memory]` 行，先确认线上镜像是否含本 change**——
> 缺它等于记忆链路全盲。
>
> **判定口径**：`finish=length` + `content=0字` ⇒ 预算被推理吃光，该加 `max_tokens`；
> `finish=stop` + `content=0字` ⇒ 另查。
> **采数据入口**：让她正常跑一天，或跑一次真实 API 探针，从 `[Life] event LLM` 行读数字。

- **现象**：事件生成依赖服务端默认预算（未知值），而它要输出一个**多字段 JSON**
  （content/type/message/mood_delta/agency/intent/next_in_hours/…），
  推理 + JSON 双重吃预算——**这是与已爆的三个槽最像的一个**。
- **证据**：`packages/core/src/provider/sampling.ts` — `life.generateEvent: { temperature: 0.9 }`（无 max_tokens）；
  消费方 `packages/server/src/modules/life.ts` 的 `generateEvent` 回调传了 `responseFormat: 'json'`。
  （★ 2026-10-02 更正：此前写的 `bootstrap.ts` 已随 P3 模块化搬走。）
- **影响**：若服务端默认偏小 → 事件生成静默失败 → **回落模板** → 她"停止生活"、
  剧情链断裂（`reference_event_id` / `continuation_of` 拿不到）、**模板句进向量库污染召回**
  （与 9-27 清掉的那 40 条垃圾向量同形）。
- **建议方向**：**先采数据**（现在采得到了）→ 再决定给不给显式 `max_tokens` / 给多少。
  **先测再改**——凭感觉填数字正是本项目反复吃亏的地方。
- ★ **2026-10-11 首批数据（部署当天，来自 `[LLM:memory]`）**：
  会话摘要槽 `session.summary`（`max_tokens=2048`）两次采样：

  | 时刻 | output | reasoning | reasoning 占比 | 可见内容 |
  |---|---|---|---|---|
  | 10:11:46 | 1081 | **882** | 82% | ~199 |
  | 13:40:43 | 1852 | **1763** | **95%** | **~89** |

  第二条只剩 **~196 tokens 余量**——**再膨胀一次就是 `finish=length` 截断**，
  与线上那 4 次 `truncated=true` 完全同形。
  ⇒ **`decide-life-event-max-tokens` 应把 `session.summary` 一并纳入**：
  它和 KI-1 是同一个「reasoning 与 content 抢同一个 `max_tokens`」问题的两个槽。
  另一条路是**把 reasoning 与 content 的预算解耦**（若 provider 支持），
  那属于更根本的改动，值得与本次决策一起评估。

### KI-2 🟠 两个小预算槽未校准：`proactive.personalize: 256` / `vision.describe: 200`

- **现象**：256 / 200 都低于「reasoning 吃掉 ~250」的量级。两者都是**纯文本**输出
  （问候文案 / 图片描述），reasoning 通常短，但没实测过。
- **证据**：`packages/core/src/provider/sampling.ts`。
- **影响**：问候/图片描述偶发空响应。**纯文本任务的 reasoning 短**，所以风险低于 KI-1。
- **建议方向**：同 KI-1，先探针实测；若无问题，在 spec §4.1.1 记一句「已实测安全」闭环。
  ★ **2026-10-02（`add-llm-budget-observability`）**：这两个槽现在**顺带可观测**了——
  provider 层的 `[LLM]` 日志对**所有槽位**统一输出 `finish=` / `reasoning=`，
  不必单独打点。做 KI-1 的采数据时，顺手看这两行的数字即可闭环本项。

### KI-3 🟡 两个 `ILLMService` 实现无一致性契约测试

- **现象**：生产链路用 `AlysiaCore` 的**内联字面量**实现（遵守三参契约）；
  E2E / 单测用 `memory/services/OpenAILLMService.ts`。两者行为**现已一致**，但无测试锁住。
- **证据**：`packages/core/src/modules/resources.ts`（内联）vs `packages/core/src/memory/services/OpenAILLMService.ts`。
  历史上正是因为后者**少声明一个形参**静默丢弃 `sampling`，让 E2E 结果不代表生产。
- **影响**：将来改一处忘另一处 → E2E 与生产再次分叉，且这次不会有人发现。
- **建议方向**：加一条契约测试：对同一槽，两个实现产出的 request body 必须相同。

---

## 🟠 静默吞错类

### KI-4 🟠 `PersonaAdapter.processSignal` 用裸 `JSON.parse`

> ★ **2026-10-16 已修**（change: [`fix-persona-adapter-json-tolerance`](../openspec/archive/2026-10-16-fix-persona-adapter-json-tolerance/proposal.md)，已归档）。
> 改用**共用解析器** `utils/llm-json.ts`（与 `ProfileExtractor` / `SessionEndProcessor` 同一套判据），
> 解析失败（`bare` / `empty`）走 `warnThrottled` **留痕**。
> 契约写进 `memory-system` §4.1.1 **契约 4**（含"当前实现分布"清单）。
> ★ 值得记的背景：`utils/llm-json.ts` 的头注写着**这个需求在本仓出现过两次、只做对了一处** ——
> 后果是会话摘要 22 天 100% 失败（全部静默）。当时 `ProfileExtractor` / `SessionEndProcessor`
> 都换了，**只有这里留着裸写法**。
> 测试里刻意分开了三种"没有调整"：① 解析失败（要 warn）② 合法 JSON 但字段不合法（不 warn）
> ③ `adjustments: []`（不 warn）—— 把后者报成失败等于**用噪声淹掉真失败**。

- **现象**：与刚修的 `ProfileExtractor` 同源写法——裸 `JSON.parse(response)`，
  catch 后注释「LLM returned invalid JSON, skip」直接放弃（**无日志**）。
- **证据**：`packages/core/src/memory/engines/PersonaAdapter.ts:57`（parse）与 `:72`（catch）。
- **影响**：模型偶发返回 markdown 围栏时，人格自适应静默失效。
  它的 prompt 含 `返回JSON` 故目前没炸，所以未被观测到。
- **建议方向**：改用共用解析器 `parseLLMJson` + 失败 `logger.warn`
  （项目已有该工具，`SessionEndProcessor` / `ProfileExtractor` 都已切过去）。

### KI-5 🟡 裸 `catch {}`：**存储层已清点完，其余待清**

> ★ **2026-10-02 更新（存储层审计 + change: `fix-migration-and-logger-silent-failure`）**：
> 「全仓清点」在**存储/迁移/日志层**已经做完，清单如下。**不再是一条"未知数量"的债。**

**✅ 本次已修（裸 catch 直接消除，不是加日志）**
- `database.ts` —— **13 处迁移裸 catch**：改为探测式 `addColumnIfMissing()`（先查再改，真失败原样抛）。
  「列已存在」是幂等成功，不是错误，所以**根本不需要 catch**。
- `utils/logger.ts` —— 3 处（`writeFileLine` / `configure` 的 mkdir / `cleanupOldLogs`）：
  改为 `console.error` **喊一次**（带标志位防刷屏；不能走 logger 自己，会递归）。

**⬜ 仍未修（已定名，按危险度排序）**

> ★ **2026-10-16 销账 8/9**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)）：
> `CronProcessor`、`PromptAssembler:158`、`PersonaStore:33-37`（**方法已删**）、
> `LanceDBStore:59`（带出真原因）、`:96`（留痕 warn）、`:160-162`（失败改抛）、
> `MemoryManager:197`（token 统计写入）、`:188/392/418`（令牌读取 / 世界观 / 生活衔接）。
> **剩 1 条**：`server/src/life.ts` 的 `tick` catch —— 它**记了 error**，只是**粒度太粗**，
> 属**日志结构**问题而非静默吞错（拆它要重划 tick 的三个阶段，宜与 `add-ops-health-report` 一起做）。
>
> ★ **同时更正了本表的一处落点**（核查得出的结论，避免后人被误导）：
> 原表把 `MemoryManager` 的 `getWorldviewBlock` 记成「会把失败**永久缓存成空**」——**不成立**：
> ① `readWorldviewBlock()` 自己就有裸 catch、**永不抛**，故 MemoryManager 那个 catch 是**死代码**；
> ② 旧代码 `catch { this._worldviewBlock = '' }` 里 `''` 是 **falsy**，下次调用仍会重试。
>
> **真正的静默吞错在 `packages/core/src/persona/loader.ts`**（原表未收录）：
> `readPersonaFile` / `readWorldviewBlock` / `readWorldbookFile` 三个读函数全部裸 catch 返回空串
> ⇒ 「`soul.md` 读不到」与「文件本来就是空的」**完全同形**，
> 而**人格核心静默缺失**正是本项目栽过的事故类型（同 `fix-role-import-wipes-persona`）。
> 这 13 个文件都随包发布（已核实）⇒ 任何读失败都是**真问题**。**已全部补 warn（按文件名限频）**。

| 位置 | 吞掉了什么 | 后果 |
|---|---|---|
| `packages/server/src/life.ts`（`tick` 的 catch） | 无——**它记了 error** | 但**粒度太粗**（★ 2026-10-16 核对机制）：`tick()` 是**一条线性链**（每日摘要 → 每日反思 → 亲密度 → 意图扫描 → 余波 → 事件生成），任一阶段抛出即**中断后续全部**，而外层 catch **不说是哪一阶段** ⇒ 生成失败/存储失败/推送未发生混在同一条，且后半段阶段**静默没跑**。属**行为问题（阶段隔离）**非吞错；修它是**行为变更**，宜与 `add-ops-health-report` 一起做 |
| ~~`CronProcessor.ts:99`~~ | ✅ **2026-10-16 已销**（归档失败 → warn：不再与"没有要归档的"同形） | — |
| ~~`PromptAssembler.ts:158`~~ | ✅ **2026-10-16 已销**（`[待确认的事实]` 块构建失败 → 限频 warn；它内部含 `expireStaleFacts` 的**写**） | — |
| ~~`PersonaStore.ts:33-37`（`migrateMemoryConfig`）~~ | ✅ **2026-10-16 已销**（方法删除，迁移由 `initializeDatabase()` 集中做） | — |
| ~~`LanceDBStore.ts:59`~~ | ✅ **2026-10-16 已销**（`openTable` 失败改为把**真原因**带出来） | — |
| ~~`LanceDBStore.ts:96`~~ | ✅ **2026-10-16 已销**（前置删除失败改为**留痕 warn**，不再无痕） | — |
| ~~`LanceDBStore.ts:160-162`（`count`）~~ | ✅ **2026-10-16 已销**（失败**改抛**，`0` 只表示"库真的是空的"） | — |
| ~~`MemoryManager.ts:197`（`saveTokenStats`）~~ | ✅ **2026-10-16 已销**（写失败 → warn，不再静默停摆） | — |
| ~~`MemoryManager.ts:188 / 392 / 418`~~ | ✅ **2026-10-16 已销**（`loadTokenStats` / `getWorldviewBlock` / `getLifeContinuityBlock` 全部补 warn，热路径点限频） | — |
| 🆕 `persona/loader.ts` 三个读函数（**原表漏收，见上文更正**） | ✅ **2026-10-16 已销**（`soul.md` 等读不到 → 带 EACCES/ENOENT 真原因 warn，按文件名限频） | — |

- **建议方向**：上面 9 条按同一手法处理——**能改探测式的改探测式，改不了的至少喊一次**。
  合并成第二刀（`fix-store-write-trace`），与下一条 KI-11 一起做。

---

## 🟠 存储写入留痕（2026-10-02 全量审计：9 store / 55 写入点）

> 起因：`life.generateEvent` 的观测补齐后，顺着问了一句「那所有存储节点有日志吗」。
> 审计结论：**留下可查痕迹的接近 0**——而且问题比"没加日志"深三层。
> 第一刀（迁移 + 日志子系统）已由 `fix-migration-and-logger-silent-failure` 落地；
> 下面这些**仍未修**，是本项目所有"静默故障"的**共同产地**。

### KI-11 🔴 52/55 个写入点不检查 `.changes`（"写成功"没有判据）

> ★ **2026-10-02 更新：观测已上线，等运行数据。**
> change `observe-zero-row-writes` 已在「0 行可疑」的写点接上 `traceZeroRows()`：
> 命中 0 行时打一行 `[WriteTrace] <类名.方法名> 命中 0 行 — <上下文>`（**只观测，不改判断**）。
> **决策入口已立**：`openspec/changes/tune-zero-row-checks/proposal.md`（📌 Backlog）。
> 跑一段时间后按 tag 统计分布，再逐点定性「豁免 / 硬校验」。
>
> **为什么不直接硬校验**：`changes === 0` 有两种含义且静态分不出来 ——
> **正常**（幂等跳过，如 `INSERT OR IGNORE` 碰到已存在的行）vs
> **异常**（写错 id / 行被并发删除 / **表结构不对，列没迁上**）。
> 一刀切会把正常路径变成噪声，**比现在更糟**。**先取证据，再改代码**（与 KI-1 同款处理）。

- **现象**：`.run()` 返回 `{changes}`，**全 core 只有 3 处看了它**（还都在 `LifeStore`）。
  `UPDATE … WHERE id = ?` 命中 0 行**不报错**——「改到了」和「什么都没改」完全同形。
- **证据**：`grep '.changes' packages/core/src` → 仅 `LifeStore.ts:149/240/246`。
- **后果（已定位的受害点）**：
  - `LifeStore.markDelivered`（`:107-109`）——「已推送」这一位**不可信**。它还在
    `life.ts:267` 推送成功**之后**、`[Life] pushed` **之前**：失败只留一条与推送无关的
    tick 错误，**没有任何日志能证明消息已经推出去了**；反向则会导致**重复推送**。
  - `WorldbookStore.recordTrigger`（`:66-71`）——命中计数空转 → **世界书采样权重失真**。
  - `WorldbookStore.updateEntry`（`:78-91`）——编辑不存在的条目**返回成功**（Web 端可见）。
  - `PersonaStore` 的 8 个 `WHERE is_active = 1` 写方法 —— 没有激活行时
    「**读到正常人格 + 写入 0 行 + 不报错**」三件事同时成立并报成功。
  - `EventStore.archiveBySession` / `deleteBySession`——**祖先级**「空转伪装成归档」。
- **方向**：见 `tune-zero-row-checks` —— **先按 tag 统计分布，再逐点定性**。

### KI-12 🔴 `EventStore.insert` 的 `INSERT OR REPLACE` 列单不含 `archived`

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)，该刀其余 4 项仍待做）。
> `insert` 不再用 `INSERT OR REPLACE`：**同 id 同内容 = 幂等空转**（一个列都不动），
> **同 id 异内容 = 不覆盖**（Event Log 不可变）+ `logger.warn` 响亮报冲突。
> 契约见 `openspec/specs/dsh-adapter/spec.md` §2.5.1 **契约 9**。
> 下面保留原始记录作为依据。

- **现象**：列单缺 `archived`，而它是 `DEFAULT 0`。同 id 重投（**QQ 重连 / 重试**）→
  **静默复活软删除的会话**、把已摘要事件的 `processed` 归 0（**再摘要 + 再画像提取**）、
  清掉 LLM 打的 `importance`、改写 `created_at`（可能挪出摘要窗口）。
- **证据**：`EventStore.ts:27-40` vs `database.ts` 的 `archived INTEGER DEFAULT 0`。
- **方向**：改 `INSERT … ON CONFLICT DO UPDATE`（只更新 payload），或列单覆盖全部状态列。

### KI-13 🔴 知识库「半截文档 + hash 去重锁死」

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)）。
> - **事务化**：新增 `KnowledgeStore.insertDocWithChunks(doc, chunks)` —— doc 与**全部 chunk
>   在同一事务里**写（`db.transaction()`，抛错整体回滚）⇒ **残壳不可能存在**。
> - **`chunk_count` 用实到块数**：doc 传入 `chunk_count: 0` 占位，
>   由事务内真正 INSERT 成功的条数回填（**不许先声明一个尚未兑现的块数**）。
> - **重试路径校验完整性**：`getByHash` 命中后核对 ① `status === 'active'`
>   ② 实际 chunk 数 > 0 且 `=== chunk_count`；不完整则 **warn + 清残壳 + 重新导入**
>   （docId 由 hash 决定 ⇒ 向量 id 不变，重建即覆盖）。
> - 复现证据：新用例修前报 `留下了伪装完整的文档壳: expected 1 to be +0`
>   与残行场景 `expected true to be false`。
>   ★ 测试用 **SQLite 触发器 `RAISE(ABORT)`** 制造**确定性**的「第 N 块写失败」——
>   比 mock 更接近真实失败（真在 INSERT 上炸），且可精确控制炸在哪一片。
> - 向量化**留在事务外**（另一条链路、失败不阻塞文本检索，见 KI-15）。
> 下面保留原始记录作为依据。

- **现象**：先落 doc（`chunk_count = chunks.length`、`status='active'`）再循环落 chunk，
  **两者不在一个事务里**。中途失败留下一个"完全正常的活跃文档"外壳；重试被 `getByHash`
  命中残行 → 返回**从未兑现的块数**并宣布「已导入 N 块」。**零日志、永不自愈。**
- **证据**：`KnowledgeStore.ts:9 / :77` + `MemoryManager.ts:1346-1390`。
- **同时命中三个已知病灶**：状态标记与实际不符 / 失败返回看起来正常的默认值 / 空转伪装成归档。
- **方向**：包事务；`chunk_count` 用实到块数；重试路径校验 chunk 实存数。

### KI-14 🟠 `LanceDBStore.insert` 永不抛 → 上游所有 try/catch 是**死代码**

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)，该刀其余 4 项仍待做）。
> `insert` / `delete` / `search` / `count` 四个方法改为 **log warn + rethrow**；
> 库不可用抛 `VectorStoreUnavailableError`（与「单次操作失败」区分）。
> 契约写进 `packages/core/src/memory/interfaces/IVectorStore.ts`：
> **`search` 的 `[]` 只表示「确实没匹配」，`count` 的 `0` 只表示「库真的是空的」**。
> 复现证据：新用例修前是 `promise resolved "undefined" / "[]" / "+0" instead of rejecting`（6 红）。
> ✅ 已确认「死代码复活」：`MemoryManager:291/1466` 的 `Promise.allSettled` 失败计数
> 与 `:543` 的 `.catch` 现在才**第一次真正会触发**。
> ⚠️ upsert 的**前置 delete** 仍不抛（LanceDB 在「谓词没匹配到」时是否抛无法在本仓证实），
> 但已改为**留痕 warn** —— 它会造成同 id 重复行（仍记在 KI-5 名下）。
> 下面保留原始记录作为依据。

- **现象**：`insert` catch 后只 warn、**不 rethrow**。于是上游每一处
  `try { insert } catch { warn('...向量失败') }` 的 warn **永远不会打印**，
  而计数照样 `applied++` / `done++`、日志照样打全绿。
- **证据**：`LanceDBStore.ts:104-106`；死代码在 `RealtimeProcessor.ts:99-102`、
  `SessionEndProcessor.ts:377-379`、`MemoryManager.ts:558`、`:1386-1388`。
- **★ 2026-09-27 那次事故的同形代码今天仍然活着**：
  `packages/server/scripts/backfill-life-importance.ts:118-138` ——
  `done++` 计的是"没抛异常"，**一条向量都没写也会打 `✅ 回填完成: 成功 N / 失败 0`**。
- **方向**：`insert`/`delete` 的失败要么 rethrow，要么返回成功/失败标记（**让调用方能判**）。

### KI-15 🟠 `vectorStore` 为 null 时**静默跳过嵌入**（10 条路径，全部无痕）

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)）。
> - **摘要与向量分开记账**（点名「最危险」的那处）：`SessionEndResult` 新增 **`vectorOutcome`**
>   （`stored` / `no-store` / `no-vector` / `failed`）；`ConversationStore.insert` /
>   `updateSummaryResult` 如实返回该值；`archiveStaleSessions` 的日志改为
>   `archived N/M …（向量：成功 X / 无库 Y / 失败 Z）` —— **全部 stored 才不加尾巴**。
> - **写路径逐次可区分**：`RealtimeProcessor` 无库时首次必报 + 每 100 条补报累计；
>   `importKnowledge` 末尾报「N/M 个 chunk 只进了文本检索」；
>   `applyImportantMoments` 末尾报「N 条的向量 metadata 未刷新」
>   （importance 写进了 events 表，但**召回读的是向量** —— 不刷新等于不生效）；
>   补处理路径（`retryFailedSummary`）无库时也留痕。
> - 顺带修了 §5.5.3 要求的裸 catch：`process()` 的 embed 失败原本是 `catch {}`。
> - ⚠️ **读路径的 `[]` 未改**（`EventStore:45` / `ConversationStore:169` / `KnowledgeStore:41`）：
>   那是**已知降级**，且 `MemoryManager.read` 已在 `!vectorStore` 时提前分流到文本检索，
>   改它们要动读路径契约 —— 留待 KI-13 / KI-16 一起评估。
> 下面保留原始记录作为依据。

- **路径**：`RealtimeProcessor.ts:85` / `MemoryManager.ts:542` / `:1378` / `:290` / `:1417` /
  `SessionEndProcessor.ts:160 / :291 / :366` / `ConversationStore.ts:17 / :61`。
- **最危险的**：`SessionEndProcessor.ts:160` 的 `if (ok && this.vectorStore)`——
  null 时摘要照写、向量静默不写，行仍是 `summary_status='ok'`，
  `MemoryManager.ts:1096-1101` 的 `archived N/M` **照打全绿**：**计数只数摘要、不数向量**。
  删除路径同理 → **孤儿向量继续被召回**（"删干净了"是假的，比丢向量更危险）。
- **读侧同形**：`MemoryManager.ts:784`（**零日志**）、`ConversationStore.ts:133`、
  `EventStore.ts:13`、`KnowledgeStore.ts:39`（都返回 `[]`）。
- **方向**：降级要**逐次可区分**（启动那一行 warn 不够）；`count()` 纳入健康检查。

### KI-16 🟠 `PersonaStore.get()` 的「读时回写默认值」**还在**

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)）。
> **兜底与回写分离**：`get()` 只把默认值填进**返回值**（新私有 `withDefaults()`），一个列都不写库；
> 真要修库里走**显式**入口 `PersonaStore.repairEmptyColumns()`（会 `warn` 出被修的列名），
> 启动期由 `al:persona-seed` 调 `MemoryManager.repairPersonaDefaults()` 触发。
> 复现证据：新用例修前报 `读操作把默认值写回库了 ⇒ 「被冲空」被伪装成「出厂默认」`。
> ✅ **顺带销掉 KI-5 一条**：`migrateMemoryConfig()`（裸 catch，`PersonaStore:33`）**整个方法已删** ——
> 它是**写探针**（每次 `get()` 都 `ALTER TABLE`），而同一列的迁移早已由
> `initializeDatabase()` 集中做（探测式 `addColumnIfMissing`）；全仓无其他调用方。
> **公开面变化**：删除 `migrateMemoryConfig()`；新增 `repairEmptyColumns()` 与
> `MemoryManager.repairPersonaDefaults()`（启动期用，Web 不需要，未登记进 Web-API 契约）。
> 📌 **同族的 `ProfileStore.migrateFact` 核查后不属同一缺陷**：它是**纯函数**、不写库；
> 「回写存量」发生在显式写入路径的 JSON blob 整体重写（该列存 JSON 数组，设计使然）。
> 下面保留原始记录作为依据。

- **现象**：检测到空的 `tone`/`speech_style`/`emotional_range` 就**填回结构默认值并写回 DB**
  （`PersonaStore.ts:21-28`）——这**本身是一次静默写操作**，且**无日志**。
- **为什么危险**：它把「人格被冲成空」**整形成一组合法出厂默认值**（与 seed 逐字相同），
  **骗过数据层，也骗过人工巡检**；`fix-role-import-wipes-persona` 只修了 `importRole` 的合并，
  **没动这层** —— 所以下一次"被冲空"**依旧只有没兜底的 `system_prompt` 会露馅**。
- **同族**：`ProfileStore.migrateFact` 读时补默认，且结果被 `writeFacts` **回写**
  → 每加一条新事实就重写一遍存量；`PersonaStore` 的三个读兜底 `[]` 会被
  `addAdaptationHint` / `appendOverlayNote` **原样写回** → 把「曾存在但读坏了」**持久化成「本来就没有」**。
- **方向**：兜底与回写分离——读可以给默认值，但**不许把默认值写回去**；真要修就显式修。

### KI-17 🟡 `summary_status` 默认 `'ok'`；`ConversationStore.updateSummaryResult` 0 行也算成功

> ★ **2026-10-16 已修**（change: [`fix-store-write-trace`](../openspec/archive/2026-10-16-fix-store-write-trace/proposal.md)）。
> - **写入默认值改 `'failed'`**（`ConversationStore.insert` 的 `?? 'failed'`）：
>   漏传状态的路径现在会「可见且可补」——`getRecent()` 不再注入空摘要、
>   `retryFailedSummaries()` 会把它捞出来。
> - **读侧 NULL → `'failed'`**。⚠️ 已核实**实际不会出现 NULL**：该列是
>   `ALTER TABLE … ADD COLUMN … DEFAULT 'ok'` 加的（SQLite 用默认值回填存量行），
>   所以此改动**零迁移风险**。
> - **`updateSummaryResult` 返回值改为 `{ rows, vector }`**，0 行 = 目标行不存在 ⇒ **不是成功**；
>   `retryFailedSummary` 据此 `return false` + 明确 warn，不再宣布「补处理成功」。
> - 复现证据：**测试本身编码了旧默认值** —— `conversation-summary-status.test.ts`
>   原有一句 `it('默认写入 ok')`，改动后立刻红（`expected 'ok' to be 'failed'`）。
> - ⚠️ **连带后果**：`getRecent` / `searchByText` **排除 failed 行**，
>   所以任何 fixture 里「代表健康摘要」的行必须**显式** `summary_status: 'ok'`
>   （已更新 3 个测试文件的 fixture）。这也提醒：**别的地方若隐式依赖旧默认值，会同样暴露**。
> - `retryFailedSummary` 此前**没有任何测试**覆盖，本次补了 2 条（rows=0 → false；rows=1 → true）。
> 下面保留原始记录作为依据。

- `ConversationStore.ts:15` 的 `?? 'ok'` 与 `:164` 的 NULL→`'ok'`：当前唯一调用方显式传值，
  属**潜伏**；将来任何新导入/迁移路径漏传就会写出"空摘要 + 状态 ok"= **22 天全绿的同款构造**。
  → 建议默认改 `'failed'`。
- `updateSummaryResult` 0 行更新时，`SessionEndProcessor.ts:313` 仍打「补处理成功」+ `return true`，
  与真正补处理**逐字相同**。→ 判 `changes === 0` 降级为失败。

---

## 🟡 结构性技术债

### KI-6 🟡 `core.stop()` 不关闭 SQLite / LanceDB

> ★ **2026-10-16 已修**（change: [`unify-core-shutdown`](../openspec/archive/2026-10-16-unify-core-shutdown/proposal.md)，已归档）。
> - `al:db` 注册停机 effect → `db.close()`（**确定性**释放）；
>   `al:vector` → `LanceDBStore.close()`（⚠️ **尽力而为**：napi 无确定性释放原语，只放掉包装引用）。
> - **顺序不需要各模块自己排**：`al:db` 第一个装 ⇒ 逆序卸载时**最后一个卸**，此刻其余模块都已卸完。
>   契约写进 `module-kernel` §2.3：内核只提供「逆序 + await + 逐个兜错」的**执行**机制，
>   **释放什么由模块用 `ctx.effect` 声明**。
> - ★ **行为变更**：`stop()` 后读写**会抛错**（better-sqlite3「connection is not open」）——
>   这正是「关太早必须响亮」。
> - ⚠️ **一处验收已完成**（2026-10-16 晚，真实 e2e）：原验收是「E2E 的 `afterAll`
>   能真删掉临时目录」。已跑通——`core-turn.test.ts` 的 afterAll **去掉了 `EPERM` 变通**、
>   改为**硬断言**，实测临时目录残留 **0 个**、停机 effect 按逆序触发
>   （日志 `[al:vector] 已释放…` → `[al:db] 已关闭…`）。
>   ⚠️ 注意这**不等于**「LanceDB 原生句柄被确定性释放」——
>   只等于 **Windows 文件锁已放开到能删除**，而那正是当初的问题。
> - ✅ **原提醒的 KI-16 交互风险已自然消解**：`PersonaStore.get()` 读路径**不再回写**
>   （`fix-store-write-trace`）⇒ 停机后一次「读」不会再触发写入。
> 下面保留原始记录作为依据。

- **现象**：`stop()` 只停 EventBus，DB 句柄与 LanceDB 目录不释放 →
  Windows 上删临时目录 `EPERM`。
- **证据**：`packages/core/tests/memory/e2e/core-turn.test.ts` 的 `afterAll` 注释（实测 EPERM）；
  `packages/core/src/modules/loop.ts` 的 `bootModule` 只注册了 `eventBus.stop()`。
- **影响**：无功能影响（仅在 shutdown 时），但让「优雅停机」名不副实。
- **建议方向**：独立 change `unify-core-shutdown`（`modularize-core-assembly` proposal 决策 2 已预留）。
  ⚠️ 它是**行为变更**，要单独验证。

### KI-7 🟡 `/stop` 命令只打日志，不做中断

- **现象**：`/stop` 打印「requested」但不真的中断。
- **证据**：`packages/core/src/modules/capabilities.ts` 的 `/stop` 回调，
  源码注释自陈「实际中断机制待 AgentRunner 支持 AbortController」（该注释早于 Coalescer 落地，已过时）。
- **影响**：命令是空转的。**注意**：Coalescer 落地后，新消息已能打断在飞生成；
  `/stop` 想要的是**主动**中断，语义不同。
- **建议方向**：接 `coalescer.getAbortRegistry()`（接口已存在，`isGenerating()` 就在用）。

### KI-8 🟡 根目录 `config.yml` 是死文件

- **现象**：服务从 `packages/server` 启动 → 读 `packages/server/config.yml`（活的）；
  根目录那份少了 `webuiToken` 等行。**改错文件毫无提示**。
- **证据**：`docs/HANDOFF.md`（`server-bind-host` 遗留节）——该次 change 第一版就写错了文件、实测没生效才发现。
- **影响**：下一个人大概率再踩一次。
- **建议方向**：删掉根目录那份，或在文件头加醒目注释。**删除前先确认没人从根目录启动过**。

### KI-10 🟡 内核缺「只排序、不依赖服务」的表达方式

- **现象**：`Module` 只能靠 `inject` 排序，没有 `after?: string[]`。
  但「A 必须在 B 之后跑」不一定意味着「A 依赖 B 提供的服务」——
  典型如「`core` 的启动日志必须落进 `logging` 配好的文件」。
- **证据**：`packages/server/src/modules/logging.ts` 提供 `al:logDir` 纯当**排序令牌**
  （`core.ts` 注入它但并不使用该值）；`openspec/changes/modularize-server-assembly/tasks.md` 有完整记述。
- **影响**：能力令牌可用但语义绕；需求一多会积累成噪音。
- **建议方向**：若这种需求 ≥3 处，给 `Module` 加 `after?: string[]`（纯排序边，不参与服务解析）。
  **现在只有 1 处，不值得加**——记在此处待观察。

### KI-9 🟡 `memory/services/` 疑似半死代码

- **现象**：`AlysiaCore.start()` 历史上用的是**内联对象字面量**（现搬到 `modules/resources.ts`），
  **没有用** `memory/services/OpenAILLMService.ts` / `OpenAIEmbedService.ts` /
  `memory/services/config.ts`。后三者只有测试在用。
- **证据**：`packages/core/src/modules/resources.ts` 的 `embedModule` / `memoryLlmModule` 是字面量实现；
  `OpenAILLMService.ts` 头部自陈「用途：E2E 测试构造 MemoryManager 的真实 LLM 服务」。
- **影响**：两套实现长期分叉（KI-3 已经因它爆过一次）。维护者会以为改动一处生效了，其实没有。
- **建议方向**：要么让生产改用这两个类（消除重复），要么明确标注「仅测试用」并把生产那套抽成正式类。
  **这是 P2/P3 重构时该顺手解决的结构问题。**

### KI-18 🟡 `/api/sessions/:id/extract` 无任何校验

- **现象**：`packages/server/src/webui/server.ts:223-227` 的 extract 路由**对 session id 不设防**——
  而同文件的邻居都有边界：`/api/ingest` 只收 `dsh:` 前缀（`ingest.ts:41`）、
  archive/delete 只收 `webui:`（`server.ts:206,216`）。
- **影响**：任何通过鉴权的调用方可以对**任意会话**触发结算（摘要 + 画像 + 人格确认）——
  既有成本（LLM 调用）也有数据正确性风险（对不该结算的会话跑提取）。
  2026-10-02 的子 agent 污染事件里，它正是「插件回传 + 结算」链路的落点
  （插件侧过滤已堵住这一条，但端点本身仍无校验）。
- **证据**：路由代码；`exclude-subagent-sessions-from-bridge` 的调查记录。
- **建议方向**：加与 ingest 同级的来源/形状校验（或至少在会话不存在时响亮失败而不是空转）。

### KI-19 🟡 同一会话可能被重复摘要（20 秒内两条 conversation）

> ★ **2026-10-16 残余也已修**（change: [`fix-concurrent-summary-duplication`](../openspec/archive/2026-10-16-fix-concurrent-summary-duplication/proposal.md)，已归档）。
> 本轮给它写复现测试时发现**两种坏结果同源**：
> ① `conversations.id = conv-${sid}-${Date.now()}` 同毫秒撞 PRIMARY KEY ⇒
> `UNIQUE constraint failed` ⇒ 异常抛给调用方、**后一次整段丢掉**；
> ② 两次调用**重叠**时两次摘同一批事件 ⇒ **两条摘要**。
> ★ **关键判断**：撞 PK 其实**歪打正着地挡住**了 ②，
> 所以"只把 id 改成唯一"会把「响的错 + 丢一条」换成「**静默重复两条**」。
> ⇒ 修法是**两件一起**：per-session 互斥（语义修复）+ id 唯一（防御）。
> 契约写进 `memory-system` §5.4.1 契约 4d。


> ★ **2026-10-11 更新：根因已坐实并修复**（change: `fix-session-end-window`）。
> 下面「疑似原因」第 2 条猜对了方向，但真正的机制更基础：
> **`MemoryManager` 的三个 SessionEnd 入口里，`onSessionEnd` / `extractProfile`
> 没传窗口锚点** → `process(sessionId)` 落到 `EventStore.getBySession` 的缺省语义
> 「全历史 `ORDER BY created_at DESC LIMIT 1000`」。
> 于是**每一次触发都会为同一段历史再造一条 conversation 行**——
> 「20 秒内两条」「45 秒内三条」都是这个机制的直接表象。
>
> 服务器实测（2026-10-11）：主线 QQ 会话 199 条摘要里 **153 条（76%）窗口跨度 > 24h**，
> **29 条恰好 `message_count=1000`、跨度 46~61 天**；
> 10-03 `12:10:00` / `12:10:45` / `12:11:24` 三条的 `started_at` 相差 1 分钟。
> 修复 = 三个入口共用一个锚点 helper（`getLatestBySession().ended_at`，无摘要回退 24h）。
> 契约见 `openspec/specs/memory-system/spec.md` §5.4.1。
> **验证口径**：部署后查新摘要行的 `ended_at - started_at` 应 ≤ 24h。

- **现象**：`conversations` 表里同一子 agent 会话在 **09:29:56 与 09:30:14** 各产生一条记录
  （实测 `dsh:9a33c81f-…`；`dsh:session-02e15a3c` 同样 2 条）。
- **影响**：重复的 LLM 摘要调用（成本）＋可能有重复/漂移的记忆摘要。
- **疑似原因（待查，未坐实）**：`session/disposed` 触发与 cron `archiveStaleSessions`
  对该会话都跑了 `SessionEndProcessor.process()`；或 `process()` 对同一窗口不幂等。
- **证据**：2026-10-02 本机库只读盘点（`conversations` 表按 session_id 分组计数 + 时间戳）。
- **建议方向**：先看 `process()` 的幂等判据（processed 位 / 摘要锚点）在「没有新消息时」是否早退，
  再决定是加幂等还是修触发方。**先取证再改**（同 KI-1 纪律）。

- **残留（未闭环）**：本 change 修的是**锚点缺失**。「两个触发方在同一窗口内并发调用
  `process()`」是否还需要**显式幂等**（例如按 session 加锁），
  等部署后用 §5.4.1 的验证口径观察一轮再定。
- ★ **2026-10-16 补记（本项的一个加重后果，新发现，尚未修）**：
  `SessionEndProcessor` 落行用的主键是 **`conv-${sessionId}-${Date.now()}`**
  （`SessionEndProcessor.ts` 的 `const conv: Conversation = { id: ... }`）。
  ⇒ 「同一会话、**同一毫秒**内跑两次 `process()`」会命中
  `UNIQUE constraint failed: conversations.id`，`onSessionEnd` 捕获后 **rethrow**
  ⇒ **后一条摘要整条丢失**（事件也不会被标记处理）。
  这不是理论：它是在 `fix-summary-window-late-events` 的幂等用例里**实测撞到**的。
  与「重复摘要」是一体两面 —— 同一根因（缺并发幂等）的两种后果：
  **窗口有内容时丢一条 / 窗口为空时白摘一次**。
  修法提示：id 加随机/序号后缀，或按 session 加锁（后者同时解决本项）。
  该 change **刻意未修**（不夹带），故仍留在此处。

### KI-20

> ★ **2026-10-17 存量数据已修复**（change: `purge-synthetic-context-pollution`，已归档）。
> 执行记录与证据见该 change 的 `tasks.md`。摘要：
> - **污染不在服务器上**（远端 0 条注入、0 条 dsh）；它在**本机备份**里 ——
>   因为 `ALYSIA_HOST` 是**回环地址**，dsh 回传打的是本机。原假设"清服务器"**清不到东西**，
>   而"把本机备份合并回服务器"会把污染**送进**生产，方向完全反了。
> - 已做：180 条注入 + 1 条派生 fact 清除 → 远端为基准**只追加 dsh 记忆**（550 事件 + 5 会话）
>   → 2378 事件 / 向量 3201 → **召回抽查通过**（dsh 向查询命中 dsh 事件，qq 向查询全 qq，互不干扰）。
> - 备份与回滚命令见 change 的 tasks.md。
>
> ⚠️ 顺带记录一个**工具级隐患**：`sync-from-server.sh` 是**整库覆盖**本机库的（虽先备份），
> 10-15 那次同步很可能就是"本机 dsh 血脉只剩备份"的原因。建议单独立 change 加警告。 🟠 dsh 的「runtime context 快照」被当用户消息回传入库（回流闭环）

> ★ **2026-10-16 取证已定案：`dsh 合成注入`，不是真实用户输入 ⇒ 该滤。**
> （本条原来挂着「先确认是合成注入还是真实用户输入」的注意项，现已回答。）
>
> **决定性证据**：在 dsh 自己的产物 `E:\dsh\resources\app.asar` 里搜那句话，
> **恰好命中 1 次**，全文为
> `` return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`; ``
> —— **前缀是 dsh 的字面量，`body` 是变量**。同一轮对话里 dsh **当前版本仍在这么做**
> （它注入的 body 是「文件策略 / 审批策略」，与用户发言完全无关）。
>
> **机制因此也解释得通**：注入的是会话里的**一条 user 角色消息** ⇒
> adapter 的「用户消息」监听器照样捕获回传 ⇒ 所以**主会话也有**（不是子 agent 专属）、
> 单会话能出现 35 次。
>
> ⚠️ **边界**：验证的是**前缀的产生者**，不是那 116 条的完整 payload 形态；
> `body` 是变量 ⇒ 过滤要按**前缀包裹整体**判定，且前缀只是**兜底**判据
> （dsh 改文案即失效），主判据仍应是事件类型与来源标记。
>
> 实现登记在 change [`filter-synthetic-context-inflow`](../openspec/archive/2026-10-16-filter-synthetic-context-inflow/proposal.md)
> （**2026-10-16 已实现并归档**）。
>
> **实现要点**（原提案里被证据改掉的两处，都记在这里）：
> - **判据只认结构化来源，不认文本前缀**：适配器把 dsh 的 `source.kind` 透传成
>   `payload.dsh_source`，服务端据此打 `skip_profile` + `synthetic`。
>   原提案写「前缀只作兜底判据」——**已改为不作判据**，因为它与
>   「用户自己粘贴类似文本不得被误判」直接冲突，而结构化判据按定义不会误伤。
> - **多堵了一条泄漏路径**：原提案只提画像与人格；实现时发现**摘要**也用全部
>   messageEvents（不看 `skip_profile`）⇒ 合成文本会进摘要、日后被召回。
>   已让 `SessionEndProcessor` 排除 `synthetic`（**只排 synthetic**，不动群聊 NPC 的既有行为）。
>
> 存量 116 条事件与由它们产出的 facts 仍需单独的数据修复方案（**未做**）。
> 下面保留原始记录作为依据。

- **现象**：全库 **116 条** events 的 payload 以
  `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` 开头，
  内容是 `[角色设定]`（人格参数）+ `[关于你]`（完整画像）+ `[关于我]`——却被标成 `role: 'user'` 入库。
  单个主会话 `dsh:session-29b9865c` 里出现 **35 次**（2026-10-02 实测）。
- **影响**：两条自指回路——
  ① **画像回吸**：`ProfileExtractor` 从画像里「重新学」出画像（facts 的 `valid_from` 被刷新、
  `source_event` 指向这些事件）。本次 `purge-subagent-pollution` 里那些「内容为真但溯源指向子会话」的
  facts 就是这个机制产出的（子 agent 的 prompt 里同样带这段快照）。
  ② **人格放大**：`PersonaAdapter` 从这段文本再触发 hints——实测 15:21:12 一条 hint 的证据是
  「记忆里轻月明确指出过『太整齐、分点…』」，即**记忆触发记忆**。
- **证据**：`events` 表 payload 前缀统计（116 条）；`dsh:session-29b9865c` 15:18–15:22 的事件流。
- **注意**：这是**主会话也有的独立缺陷**——与「子 agent 回传」不同源，子 agent 过滤解决不了它。
- **建议方向**：adapter 侧过滤这类合成消息（payload 前缀判据），或提取侧对
  `Current runtime context` 开头的 payload 打 `skip_profile`（后者是现成机制）。
  ⚠️ 先确认这段文本是 dsh 合成注入还是真实用户输入（前者才该滤）。

### KI-21 🔴 记忆链路 LLM 客户端**没有超时** → 一次网络中断把请求挂了 117 分钟

> ★ **2026-10-11 已修**（change: `add-memory-llm-timeout`，同日部署）。
> 给 `al:memory-llm` 补了 **120s 超时**（`AbortController` + `Promise.race`，
> 与聊天链路同款机制；超时值取 120s 而非 60s 是因为记忆链路是批处理、
> 输出契约更长）。**超时抛错而非返回空串**——避免把网络故障伪装成「模型没输出」。
> 契约见 `openspec/specs/memory-system/spec.md` §4.1.3 契约 6。
> 下面保留原始记录作为依据。

- **现象**（2026-10-11 线上实测）：`POST /api/sessions/<qq>/extract`
  （= 控制台「提取画像」按钮）的日志为
  `[Memory] extractProfile: 0 new facts, summary ok (7039529ms)` —— **7,039,529ms ≈ 1 小时 57 分**。
  发起后 HTTP 请求一直不返回，把发起方的连接一起拖死。
- **根因**：`modules/resources.ts` 的 `al:memory-llm` **绕开 ProviderManager 直连 `fetch`，
  没有 `AbortController` / 没有超时**（`resources.ts` 内的注释已自陈这是历史现状）。
  对比：**聊天链路**的 `provider/openai.ts` 有 **60s 超时 + Promise.race**
  （就是为 `llm-request-timeout-race` 那个事故加的）。
  同一断网窗口里两条链路的日志对比非常清楚：
  ```
  [10:49:47] [ERROR] [LLM] deepseek-v4-flash timed out after 60s        ← 聊天链路：60s 就放弃
  [10:50:10] [WARN] [Life] event LLM call failed (310724ms)             ← 事件槽：310s
  [12:08:56] [INFO] [Memory] extractProfile: … (7039529ms)              ← 记忆链路：117 分钟
  ```
- **触发场景**（同日 10:13–12:13 宿主机网络中断，见下「同批次发现」）：
  断网期间发出的记忆链路请求**不会失败，只会挂住**——不报错、不降级、不留痕，
  直到 TCP 自己放弃。上层（`extractProfile` / `onSessionEnd` 的调用方）全部被阻塞。
- **影响**：① Web「提取画像」按钮卡死近 2 小时；② `onSessionEnd` 被 `llm-agent.ts`
  **不 await** 地调用，所以它挂住不会阻塞聊天——但会**长期占住一条 promise 与其持有的
  events 快照**；③ 断网期间 cron 的 `archiveStaleSessions` 也可能整轮卡住。
- **证据**：`alysia-2026-10-11.log`（上述三行）；`docker logs alysia-server --since 1h`。
- **建议方向**：给 `al:memory-llm` 补**与聊天链路同款的 60s 超时 + `AbortSignal`**
  （属行为变更，需独立 change）。★ 注意与 `instrument-memory-llm` 的分工：
  那一刀只补**观测**，明说了「不改超时/signal/fallback」。

### ⚠️ 同批次发现（★ 当晚更正）：**根因是宿主 DNS，不是内存**

> ⚠️ **初稿把 2026-10-11 那次 2 小时断网归因成「内存吃紧」，那是错的。**
> 当晚查 journal 拿到真凭据：**dockerd 的 DNS 解析器在上游超时**。
> 本节保留更正过程，因为「先写错再纠正」这件事本身值得留痕。

**真正的现象**（`journalctl -u docker`）：

```
[10:31:34] dockerd: error   "[resolver] more than 1024 concurrent queries"
[10:33:10] dockerd: warning "[resolver] connect failed" dial udp 127.0.0.53:53: i/o timeout
[11:44:29] dockerd: error   "[resolver] failed to query external DNS server"
                 question=";api.sgroup.qq.com.  IN  AAAA"
```

**解析链路**：`容器 → 127.0.0.11（Docker 内嵌）→ 宿主 127.0.0.53（systemd-resolved）`。
`resolvectl statistics`：**148,980 miss / 1,618 hit、4 次上游超时**，`NRestarts=0`。

**能同时解释「两个无关容器一起挂」+「三套 API 全中」+「12:13 自愈」**——
共用宿主 stub resolver，上游恢复即全线恢复。

**为什么排除内存**：`OOMKilled=0`；7 天 `oom-kill` **0 次**；
**swap 只用 268K / 2047MB**——有 swap 却不换页，内核不认为内存告急。

**今天独有**：DNS 故障 `10-09 = 0` / `10-10 = 0` / `10-11 = 8`，不是慢性病。

**建议的针对性缓解**（**尚未执行**）：`/etc/docker/daemon.json` 加
`"dns": ["223.5.5.5", "119.29.29.29"]`，让容器绕开宿主 stub resolver。

#### 内存吃紧仍然属实，但**降级为「背景噪声」而非事故根因**

- `available` 长期只有 ~180MB（总 1613MB）；大户是 **astrbot 549MB** + casaos 全家桶 ~260MB，
  **alysia-server 只占 54MB**。
- `journald: Under memory pressure, flushing caches` 7 天 **635 次**（最近一次就在刚才）——
  这是 systemd 的 **PSI 触发式刷缓存**，**不是危机指标**。
- `/var/log/journal` = **3.2GB**（攒了 83 天，7-20 起），`journald.conf` 全默认
  → 上限是文件系统的 10%（≈4G），属**正常涨到接近上限**。
- **它不占 RAM**（在磁盘上），所以 `journalctl --vacuum-size=200M` 回收的是**磁盘**（约 3.1GB），
  **不会解决 DNS 问题、也不会明显缓解内存**。
- ⚠️ journal 里**几乎没有昔涟的日志**（近 7 天提到 alysia 仅 22 行）——
  应用日志在 `~/alysia/data/logs/`，容器 stdout 在 `/var/lib/docker/containers`（26MB）。
  **清 journal 不会丢任何昔涟的日志。**

---

## 🟠 2026-10-11 第二轮 CR（dsh 桥接 + PersonaStore）

> 来源：业务负责人逐条点出的 5 项。**已逐条对代码核验**，结论见每条开头。
> 4 条成立（其中 1 条当前不可达、1 条触发未证实），1 条是 8-29 CR 的同一条。

### KI-22 🟡 `PersonaStore.upsertRole` 激活新角色时**不清旧主动行**（写侧会同步改两行）

> ★ **2026-10-16 已修**（change: [`fix-role-activation-invariant`](../openspec/archive/2026-10-16-fix-role-activation-invariant/proposal.md)，已归档）。
> `upsertRole` 的激活改为与 `setActive` **同语义**（同事务内**先清后置**）；
> 新建行一律先插 `is_active = 0`；`get()` 加 `ORDER BY id` 作**兜底**（针对历史脏数据）。
> 契约写进 `role-system` §2.3。
> ★ 复核时确认了下面「为什么现在没爆」的判断**仍然成立**：
> 当时之所以观测不到双激活，是因为唯一调用方 `importRole` 在约 50 行后顺手调了 `setActive`
> —— **那是调用顺序的巧合，不是不变量**，所以本项仍按缺陷修（不因"不可达"而放过）。
> ⚠️ **未做**：8 个写点仍是不带 `LIMIT 1` 的 `UPDATE … WHERE is_active = 1`。
> 写入侧已保证单一激活，故**不需要**给它们打补丁；若将来又出现双激活，
> 应先查是哪条写入路径破坏了不变量，而不是给读侧加 `LIMIT`。
> 下面保留原始记录作为依据。

> **核验结论：代码属实，但当前「不可达持久双激活」** —— 见下面的「为什么现在没爆」。

- **现象（代码属实）**：`upsertRole` 用
  `is_active = CASE WHEN ? = 1 THEN 1 ELSE is_active END`（`PersonaStore.ts:108`，
  INSERT 分支 `:119` 同理）——**只置位不清别人**。而同文件 `setActive`（`:73-82`）
  写对了：事务内先 `SET is_active = 0 WHERE is_active = 1` 再置位。
- **★ 写侧放大（本轮新增观察，8-29 CR #19 没写这一面）**：8 个写点
  （`:144/154/162/170/180/204/222/231`）是 `UPDATE persona … WHERE is_active = 1`
  **无 `LIMIT 1`** → 双激活时**两行一起被改**；而 `get()`（`:61`）是
  `SELECT * FROM persona WHERE is_active = 1 LIMIT 1` **且无 `ORDER BY`** → 只读其中
  **不确定哪一行**。所以不是「读旧了」，而是**读与写分叉且不可预测**：
  人格演化（tone/hints/overlay/memory_config）会同时写进两个角色，读却只认一个。
- **为什么现在没爆**：`upsertRole` 全仓**只有一个调用方**——`MemoryManager.importRole`
  （`:1533`），而它在**同一个函数里、约 50 行后**（`:1587`）紧跟
  `if (pkg.activate) setActive(pkg.role)`，且**中间全是同步代码**（worldbook 的
  digest 读 / delete / insert，无 `await`）→ 双激活窗口**在同一 tick 内被修好，外部观测不到**。
  ⚠️ 这个「修好」靠的是**调用顺序**，不是任何不变量——`PersonaStore` 本身不保证它。
- **影响**：属**潜伏的 API 契约缺陷**（该方法本身的契约不安全），
  不是正在发生的 bug。风险来源是**下一个调用方**：任何新增的 `upsertRole(...is_active:true)`
  调用点都会真的留下双激活行，而那时症状是「人格改了没生效 / 随机漂移」，很难查。
- **建议方向**：把 `upsertRole` 的激活走 `setActive` 的语义（同事务先清后置），
  并给 `get()` 加 `ORDER BY id`（消掉不确定性）。**顺带**核一遍 8 个写点要不要 `LIMIT 1`
  ——更稳的做法是双激活在写入侧就不可能产生，读侧加 `ORDER BY` 只是兜底。
- **登记重复说明**：本项与 `docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md` **#19** 是同一条
  （同位置、同描述）。#19 的状态表记 ☐，但**该表整体已过期**（P0-1/P0-2 早已修复归档）。

### KI-23 🟠 dsh 拿不到 `session.id` 时退化成 `dsh:unknown`，**多个真实会话挤进同一个桶**

> ★ **2026-10-16 已修**（change: [`fix-dsh-ingest-and-settlement`](../openspec/archive/2026-10-16-fix-dsh-ingest-and-settlement/proposal.md)，已归档）。
> `sessionIdOf()` 返回类型改为 `string | null`（**删掉 `'unknown'` 字面量**），
> 取不到 id 时**不回传、不结算** + 限频诊断（每类事件首次一行 warn，其后静默计数）。
> **第二道闸**：服务端 `/api/ingest` 同步拒收字面量 `dsh:unknown`
> （`packages/server/src/ingest.ts` 的 `UNKNOWN_SESSION_ID`），拒绝原因具体。
> 契约见 `openspec/specs/dsh-adapter/spec.md` §2.5.1 **契约 7**。
> 下面保留原始记录作为依据。

> **核验结论：成立，无任何守卫。**

- **现象**：`session-id.ts:29` 的 `sessionIdOf()` 在取不到 id 时返回字面量 `'unknown'`
  （注释自陈「宁可退化到 unknown 也不要抛」）。调用方**照常继续**：
  `index.ts:220` 取 sid → `:225` 刷缓存、`:245` `session_id: 'dsh:unknown'`、
  `:273` `extractSession('dsh:unknown')`。
- **影响**：多个不同真实会话的事件、画像、摘要**全部落进 `dsh:unknown` 一个会话**：
  ① 跨会话内容混进同一份摘要与画像（等价于上一次修的「子 agent 污染」，但更难发现）；
  ② `summaryAnchor()` 会拿 `dsh:unknown` 的**最新摘要**当锚点 → 窗口跨会话错乱；
  ③ 子 agent 去重集 `notedSubagents`（`:175`）也按 sid 去重 → 全塌成一条日志。
- **为什么危险**：与「子 agent 会话」的处理**不一致**——那一类**跳过**
  （fail closed，`skipSubagentSession`），这一类却**照常写**（fail open）。
  dsh 已经换过一次插件机制（见 CLAUDE.md「dsh 侧上游已变」），
  `Session` 形状一旦变化，退化路径就会静默开启。
- **证据**：`packages/dsh-adapter/src/session-id.ts:26-30`；`types.ts:87`
  对第一个参数的静态类型就是 `unknown`（**没有编译期保证**）。
- **建议方向**：把 `unknown` 当**失败**处理（记 warn + **不回传、不结算**），
  与子 agent 同一条纪律；或至少在 `installBridge` 入口 `throw`（响亮失败优于静默混桶）。

### KI-24 🔴 dsh `turn/end` 的 flush 还在飞，`session/disposed` 的 flush+结算就抢跑 —— 会话末条**永久不进摘要**

> ★ **2026-10-16 已修**（change: [`fix-dsh-ingest-and-settlement`](../openspec/archive/2026-10-16-fix-dsh-ingest-and-settlement/proposal.md)，已归档）。
> 投递队列新增 `packages/dsh-adapter/src/delivery.ts`：`drain()` 返回一条**覆盖在途批次**的
> promise 链（串行化），`session/disposed` 改为 `drainThenSettle`——
> **排空成功才结算**，回传失败则**挂起**（不写假的完成态），
> 并在**下一次成功排空后自动补做**（再次结算入口，同会话去重、尝试次数上限 3）。
> 契约见 `openspec/specs/dsh-adapter/spec.md` §2.5.1 **契约 2 / 5 / 6**。
> ⚠️ **已知边界**：若插件实例在排空成功前就卸载，重试链随之消失——
> 此时只保证「不结算 + 响亮失败」，不保证补上。
> 下面保留原始记录作为依据。

> **核验结论：成立，且后果是永久性的（本轮最严重的一条）。**

- **现象**：两条**互不相干**的异步链，没有任何互斥：
  - `index.ts:232-233` `turn/end` → `void flush()`（**不 await**）
  - `index.ts:267-275` `session/disposed` → `void (async () => { await flush(); await client.extractSession(...) })()`
  `flush()` 开头就 `const batch = pending; pending = []`（`:195-196`）——
  所以上一批**在飞**时，`disposed` 的 `flush()` 看到的是空队列，**立刻返回**，
  紧接着 `extractSession` 就开跑。
- **为什么后果是永久的**（这条是本轮补出来的，原描述只说「可能没入库就被结算」）：
  服务端结算 `process()` 的窗口是 `created_at >= anchor`，
  `anchor = 该会话最新摘要的 ended_at`（`summaryAnchor`），
  而新落库的摘要行 `ended_at = 服务端当时时间`。
  迟到的那些事件 `created_at` 取自 **dsh 的事件时间**（`index.ts:257`
  `new Date(event.time || Date.now())`）——**早于**那条摘要的 `ended_at`
  ⇒ 它们**落在下一次窗口之外，永远不会被摘要**。
  且摘要行是 `summary_status='ok'`（不是 failed），`retryFailedSummaries()` **不会补**。
  ⇒ **不是「晚一点摘到」，是「永久摘不到」。**
- **影响范围**：所有 dsh 会话的**最后一轮对话**都可能缺席摘要
  （画像提取同窗口，因此那批也缺席）。事件本身仍在事件表里，
  所以 `read()` / 向量召回**仍能捞到**——丢的是**摘要与画像这一层**，更难察觉。
- **加重场景**：alysia 不可达时 `flush()` 会把批次**放回 `pending`**（`:198-207`），
  而 `disposed` 的 `flush()` 可能已经跑过 → 该批要等**下一个会话**的 `turn/end`
  才可能被送走（`pending` 是跨会话共享的单数组）。
- **证据**：`packages/dsh-adapter/src/index.ts:195-196, 232-233, 267-275`；
  服务端锚点见 `MemoryManager.summaryAnchor()` 与 spec §5.4.1。
- **建议方向**：给 `flush()` 加**串行化**（复用一个在飞 promise 链），
  `disposed` 必须 `await` **队列真正清空**（含在飞那批）再 `extractSession`；
  或让结算走「先 flush → 确认 accepted 数 → 再 extract」的两段确认。

### KI-25 🟡 dsh 事件去重键取 `event.seq`，撞上 `INSERT OR REPLACE` —— **触发条件未证实**

> **核验结论：机制成立（KI-12 已登记），但「seq 会重数」这一**前提尚无证据**。**

- **现象**：`index.ts:244` 用 `id: \`dsh-${sid}-${event.seq}\`` 做去重键。
  注释自陈意图是「同一事件重传不会在记忆里产生两条」——即**假设同一 session 内
  `seq` 跨重传/重启稳定**。若 dsh 重启或 resume 后 `seq` 从头重数，
  新事件会与历史事件**撞同一个 id**。
- **撞上之后会怎样**：`/api/ingest` → `MemoryManager.ingest`（`:765`）
  → `EventStore.insert` 用的是
  `INSERT OR REPLACE INTO events (id, session_id, source, type, payload, importance, created_at, processed, perspective)`
  （`EventStore.ts:29`）——**列单不含 `archived`** ⇒ 冲突时该列**回落默认 0**，
  于是一条软删除（`archived=1`）的事件会被**复活**，且内容被新事件覆盖。
  这正是已登记的 **KI-12**，本项是它的**dsh 侧触发路径**。
- ★ **2026-10-16 后果已变（KI-12 修复后）**：不再覆盖、不再复活软删行，改为
  **保留原事件 + `logger.warn` 报冲突**。所以 `seq` 真重数的后果从
  「**旧事件被改写/复活**」变成「**新事件被丢弃**」——即那几轮对话**进不了记忆**
  （日志有 warn，但不再是数据被污染）。⇒ 未证实的那一点**仍然必须查**：
  两种后果都不可接受，只是形态不同。另注：现在**没有任何自动重试**会补上被丢弃的新事件
  （该 id 已存在，`insert` 只会幂等空转）。
- **未证实的关键点**：`seq` 的语义（是否跨 restart/resume 单调）。
  ⚠️ 本仓**没有任何地方记录它**——`openspec/specs/dsh-adapter/spec.md` 里
  `seq` **零命中**，测试只硬编码 `seq: 1 / 7`。dsh 实现打包在 `app.asar` 里，
  本次未能核验。**先取证再改**（同 KI-1 纪律）。
- **★ 顺带发现**：`SessionEvent` **同时**有 `id: number` 与 `seq: number`
  （`types.ts:67-68`）。若 `id` 是会话事件日志自身的条目主键（更常见的语义），
  它比 `seq` 更适合做去重键——**建议核实后改用它**。
- **建议方向**：① 先确认 `seq` 是否跨 restart 单调；② 更稳的是**别让去重键依赖 dsh 的序号**，
  改用 `sid + created_at + 内容哈希`（幂等性与 dsh 内部实现解耦）；
  ③ 无论选哪种，KI-12（`INSERT OR REPLACE` 补上 `archived`）都该一并修。

---

### KI-26 🟠 「没有历史摘要 + 消息全部早于 24h」⇒ 那批消息**永远进不了摘要**

> **发现方式**：2026-10-16 跑真实 e2e 时，`cron.test.ts` / `real-api.test.ts`
> 各挂 1 条（`basics` 没被重写、**facts 一条没提出来**）。核实后确认
> **不是当轮那批改动的回归**（baseline `HEAD` 的 `summaryAnchor()` 与工作区逐字相同、
> 这两个用例一行没动），而是暴露了这个既有行为问题。
>
> ★ **2026-10-16 已修**（change: [`fix-summary-anchor-floor`](../openspec/archive/2026-10-16-fix-summary-anchor-floor/proposal.md)，已归档）。
> 无历史摘要时下界改为「**该会话最早的事件 − 1ms**」，**不设时间上限**。
> 真实 e2e **用例一行未改**即转绿（`cron` / `real-api` 由挂转过）。
>
> **决定性的判断（记下来防止后人重走）**：`now − 24h` 兜底是 **2026-10-11 事故的对策**，
> 不是疏忽；但那次事故的**病因**是「三个入口都没传锚点 ⇒ **同一段历史被反复摘要**」
> （45 秒内连摘三次），**坏窗口 46~61 天只是症状**。病因已被"锚点只此一处 + 摘完就前进"堵死
> ⇒ 加上限反而是把**静默永久丢失**换回来。
> ⚠️ **我一度实现了"7 天有界版"并跑通 core 757 绿，随后自己推翻**：
> 上限无法覆盖事故自己的症状场景（e2e fixture 距今三个半月，任何有限上限都挡在外面，
> 实测仍是 3/5），且它把"永久丢失"换成了"**小声的**永久丢失"，而本项的教训恰恰是静默最危险。
> ⚠️ **残留风险（未解决）**：从未摘过且超过 `LIMIT 1000` 条的会话，最老那批仍够不到
> —— 彻底做法是**分块回填**（见下表「历史画像回填」）。

- **现象**：`MemoryManager.summaryAnchor(sessionId)`（`MemoryManager.ts:1086`）在
  「**这个会话还没有上一份摘要**」时，用 **`Date.now() − 24h`** 作窗口下界：

  ```ts
  const last = this.conversationStore.getLatestBySession(sessionId);
  const anchor = last?.ended_at ? new Date(last.ended_at)
                                : new Date(Date.now() - 24 * 3600 * 1000);
  ```

  ⇒ 只要该会话的**消息都早于「现在 − 24h」**，下界就把它们全部排除
  ⇒ `process()` 走到 `no-events` 直接返回 ⇒ **既不产摘要、也不产 facts**。
- **为什么是"永远"**：这些事件**没有被标记 `processed`**，看似"下次还有机会"；
  但下一次的锚点是「上一份摘要的 `ended_at`」——而**上一份摘要根本不存在**，
  于是每回都退回 `now − 24h`，而"now"还在往前跑 ⇒ **越等越够不着**。
- **可复现的真实场景**：会话开着超过 24 小时才结束（dsh 的长会话、
  QQ 群里持续几天的会话），或进程停过一段时间后由 `archiveStaleSessions` 归档 ——
  首批消息（最老那一段）**永久不进摘要**。属 KI-24「永久不进摘要」同一族。
- **为什么现在没爆**：常见路径是「会话结束时就摘要」——那一刻消息都是新鲜的，
  `now − 24h` 全都包含在内。**只有"结束得太晚"才漏**，而那一刻通常没人盯。
- **取证**：e2e 里把事件 `created_at` 写死成 `2026-06-28`（比 `now − 24h` 早三个多月）
  即**稳定复现**；对照 `full-session.test.ts` 用 `new Date()`，同一套代码 facts 正常提取。
- **建议方向**（**未动手**）：兜底下界不该用「现在」，而应当用
  「**该会话最早事件的 `created_at`**」（没有历史摘要时的语义 = 从头摘要）；
  或退一步用会话的 `started_at`。⚠️ 改之前要评估**重摘要风险**：
  下界放宽到"从头"会让任何未标记 `processed` 的旧事件重新进入摘要，
  需要确认不会与 `processed` 位形成二次摘要（KI-19 同族风险）。
- **优先级**：🟠（是**静默丢失**，且丢了以后无法从摘要恢复；但触发条件是"结束得太晚"，
  不是每条消息都受影响）。修它应走独立 change（本项只登记）。

---

## 📌 已定名但未开 change

| 名字 | 内容 | 出处 |
|---|---|---|
| 历史画像回填 | 线上 `basics`/`facts` 长期稀疏，修复只保证从此往后；回填需重跑历史 `onSessionEnd`，成本与副作用待评估 | `fix-profile-extract-empty-response` tasks 遗留 |

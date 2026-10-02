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
> - `[LLM] <model> → … tokens=… finish=<x> reasoning=<n|?> (…)` —— **所有槽位全局可见**
> - 空响应会单独 warn，并直接指出「预算耗尽」还是「不是预算问题」
> - `[Life] event LLM: finish=… tokens=… reasoning=… content=N字 (…)` —— 事件槽位级现场
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

| 位置 | 吞掉了什么 | 后果 |
|---|---|---|
| `packages/server/src/life.ts`（`tick` 的 catch） | 无——**它记了 error** | 但**粒度太粗**：生成失败/存储失败/推送未发生混在同一条，日志上像是"这一轮什么都没发生" |
| `CronProcessor.ts:99` | 知识库归档失败 | 90 天该归档的文档一个没归档，日志表现为"没有需要归档的文档" |
| `PromptAssembler.ts:158` | `expireStaleFacts` 的**写**失败 | 过期事实永不清理，且是唯一自动调用点 → 端到端静默 |
| `PersonaStore.ts:33-37`（`migrateMemoryConfig`） | `ALTER TABLE` 失败 | 人格 `memory_config` 列没加上也无人知 |
| `LanceDBStore.ts:59` | `openTable` 的**所有**失败都被当作"表不存在" | 最终 warn 里的报错是**误导性的** |
| `LanceDBStore.ts:96` | 删旧行失败 | 同 id 两条向量并存 → 召回里同一条记忆重复出现，无痕 |
| `LanceDBStore.ts:160-162`（`count`） | 读失败 → 返回 `0` | 「库是空的」与「库读不了」完全同形 |
| `MemoryManager.ts:197`（`saveTokenStats`） | **写**统计文件失败 | token 统计静默停摆（喂 `/api/stats`） |
| `MemoryManager.ts:188 / 392 / 418` | 读失败 → 默认值 / `''` | 其中 `getWorldviewBlock` 会把失败**永久缓存成空**（每轮 prompt 少一段） |

- **建议方向**：上面 9 条按同一手法处理——**能改探测式的改探测式，改不了的至少喊一次**。
  合并成第二刀（`fix-store-write-trace`），与下一条 KI-11 一起做。

---

## 🟠 存储写入留痕（2026-10-02 全量审计：9 store / 55 写入点）

> 起因：`life.generateEvent` 的观测补齐后，顺着问了一句「那所有存储节点有日志吗」。
> 审计结论：**留下可查痕迹的接近 0**——而且问题比"没加日志"深三层。
> 第一刀（迁移 + 日志子系统）已由 `fix-migration-and-logger-silent-failure` 落地；
> 下面这些**仍未修**，是本项目所有"静默故障"的**共同产地**。

### KI-11 🔴 52/55 个写入点不检查 `.changes`（"写成功"没有判据）

- **现象**：`.run()` 返回 `{changes}`，**全 core 只有 3 处看了它**（还都在 `LifeStore`）。
  `UPDATE … WHERE id = ?` 命中 0 行**不报错**——「改到了」和「什么都没改」完全同形。
- **证据**：`grep '.changes' packages/core/src` → 仅 `LifeStore.ts:149/240/246`。
- **后果（已定位的受害点）**：
  - `LifeStore.markDelivered`（`:107-109`）——「已推送」这一位**不可信**。它还在
    `life.ts:267` 推送成功**之后**、`[Life] pushed` **之前**：失败只留一条与推送无关的
    tick 错误，**没有任何日志能证明消息已经推出去了**；反向则会导致**重复推送**。
  - `WorldbookStore.recordTrigger`（`:66-71`）——命中计数空转 → **世界书采样权重失真**。
  - `WorldbookStore.updateEntry`（`:78-91`）——编辑不存在的条目**返回成功**（Web 端可见）。
  - `EventStore.archiveBySession` / `deleteBySession`——**祖先级**「空转伪装成归档」。
- **方向**：写入必须检查 `.changes`（或显式豁免）；**但需先定口径**——幂等跳过（如
  `INSERT OR IGNORE`）为 0 是正常的，一刀切会把正常路径变成噪声。

### KI-12 🔴 `EventStore.insert` 的 `INSERT OR REPLACE` 列单不含 `archived`

- **现象**：列单缺 `archived`，而它是 `DEFAULT 0`。同 id 重投（**QQ 重连 / 重试**）→
  **静默复活软删除的会话**、把已摘要事件的 `processed` 归 0（**再摘要 + 再画像提取**）、
  清掉 LLM 打的 `importance`、改写 `created_at`（可能挪出摘要窗口）。
- **证据**：`EventStore.ts:27-40` vs `database.ts` 的 `archived INTEGER DEFAULT 0`。
- **方向**：改 `INSERT … ON CONFLICT DO UPDATE`（只更新 payload），或列单覆盖全部状态列。

### KI-13 🔴 知识库「半截文档 + hash 去重锁死」

- **现象**：先落 doc（`chunk_count = chunks.length`、`status='active'`）再循环落 chunk，
  **两者不在一个事务里**。中途失败留下一个"完全正常的活跃文档"外壳；重试被 `getByHash`
  命中残行 → 返回**从未兑现的块数**并宣布「已导入 N 块」。**零日志、永不自愈。**
- **证据**：`KnowledgeStore.ts:9 / :77` + `MemoryManager.ts:1346-1390`。
- **同时命中三个已知病灶**：状态标记与实际不符 / 失败返回看起来正常的默认值 / 空转伪装成归档。
- **方向**：包事务；`chunk_count` 用实到块数；重试路径校验 chunk 实存数。

### KI-14 🟠 `LanceDBStore.insert` 永不抛 → 上游所有 try/catch 是**死代码**

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

- `ConversationStore.ts:15` 的 `?? 'ok'` 与 `:164` 的 NULL→`'ok'`：当前唯一调用方显式传值，
  属**潜伏**；将来任何新导入/迁移路径漏传就会写出"空摘要 + 状态 ok"= **22 天全绿的同款构造**。
  → 建议默认改 `'failed'`。
- `updateSummaryResult` 0 行更新时，`SessionEndProcessor.ts:313` 仍打「补处理成功」+ `return true`，
  与真正补处理**逐字相同**。→ 判 `changes === 0` 降级为失败。

---

## 🟡 结构性技术债

### KI-6 🟡 `core.stop()` 不关闭 SQLite / LanceDB

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

---

## 📌 已定名但未开 change

| 名字 | 内容 | 出处 |
|---|---|---|
| `unify-core-shutdown` | 统一停机清理（= KI-6） | `modularize-core-assembly` proposal 决策 2 |
| 历史画像回填 | 线上 `basics`/`facts` 长期稀疏，修复只保证从此往后；回填需重跑历史 `onSessionEnd`，成本与副作用待评估 | `fix-profile-extract-empty-response` tasks 遗留 |

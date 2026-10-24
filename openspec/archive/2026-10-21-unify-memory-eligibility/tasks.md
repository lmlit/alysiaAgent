# Tasks: unify-memory-eligibility

> 顺序即依赖顺序：**先立判据（T1）→ 再让调用方接入（T2/T3/T4）→ 最后才是谱系与重建（T5/T6）**。
> 反过来做会把新判据塞进旧接口，等于又抄一份。
>
> ⚠️ 跑测试必须 Node 24（`E:\nodejs24\node.exe`）。默认基线与最新数字以 `docs/HANDOFF.md` 顶部为准。
> ⚠️ 每项都**先写红测**再改实现；"改完跑绿"不算完成，要有"改前必红"的记录（commit message 里写一句）。

## T0. 拍板与开工前确认

- [x] **D1 = assistant 完全退出人格证据链**（2026-10-21 用户拍板）
- [x] **D2 = 反思只进【关于我】，不算人格证据**（同日拍板）
- [x] **D3 = 每窗口自动重试 1 次**（同日拍板）
- [x] 确认本 change **不动存量数据**（只加列、只改写入与读取口径）
- [x] 分支 `feat/unify-memory-eligibility`（已建；**尚未提交**，等你看过 diff）

## T1. 判据单一来源（C1）—— ✅ 已完成 2026-10-21

- [x] 新建 `packages/core/src/memory/eligibility.ts`（纯函数、无 I/O、无 logger）
  - `originOf()` 判定顺序即优先级；机器标记**优先于 role**
  - `isEligible()` / `filterEligible()` / `isMachineOrigin()` / `describeSkip()`
  - `ELIGIBILITY` 矩阵 + `MEMORY_USES` / `EVENT_ORIGINS`（缺格即红）
- [x] 红测：`packages/core/tests/memory/eligibility.test.ts`（**17 条**）
  - 矩阵完整性：每格都是 boolean，且"禁止"必须带得出 `reason`
  - 来源判定 9 条（含老数据 `sender_id`、`role:engine`、`perspective:self`、synthetic 优先于 NPC）
  - 用途判定 5 条（assistant 可摘要/可嵌入但不可学；机器来源只可 worldbook；npc 可摘要）
- [x] `scripts/check-memory-eligibility.cjs`：processors/engines 内**禁止**自带资格判定
      （`--strict` 额外查 `getAllFacts`，供 T3 收口后设为默认）
- [x] 接进 pre-commit（`scripts/git-hooks/pre-commit` 第 ③ 段）：仅当暂存区动了
      `packages/core/src/memory/*` 才跑，避免无关提交被拖慢

## T2. 三个处理器接入判据（C1，替掉各自的 if）—— ✅ 已完成 2026-10-21

- [x] `RealtimeProcessor.process`：一次算出 `facts/persona/correction/embed` 四个判据；
      四种全不允许 ⇒ 只留流水账（事件仍在事件表里）
- [x] **E4 收闸（D1）**：人格扫描与纠正快路径只认 `user` 来源 ⇒ **她自己的话不再改她自己**
- [x] `ProfileExtractor.extract`：三段手写 filter 换成 `filterEligible(events, 'profile-facts')`
- [x] `SessionEndProcessor`：`processInner` 与 `retryFailedSummary` **共用 `dialogueOf()`** ——
      E1 的修法是**删掉一份**，不是再补一个 filter
- [x] `EventStore.getLastUserMessageAt`：SQL 判据**刻意保留**（热路径），注释指向 `eligibility.ts`
      并写明"这是已知重复点，靠注释对账，不靠机器"
- [x] 接线红测：`packages/core/tests/memory/eligibility-wiring.test.ts`（**6 条**）
  - 已验证**先红后绿**：把 src 三个文件 stash 掉后，其中 3 条（E4 两条 + E1 对称性）**必红**

### 顺手修的（与本次判据无关，但它让基线每天都红）

- [x] `prompt-assembler-characterization.test.ts`：快照里有「(N天前)」，N 相对**当前时钟**算 ⇒
      这份快照**每过一天就红一次**（2026-10-21 实测：期望 19、实际 20）。
      改为 `vi.useFakeTimers({ now: 2026-10-20T08:00Z })` 冻结时钟 ——
      否则"基线变红"本身失去信号：分不清是回归还是日历翻了页。

## T3. 当前态读取（C2）—— ✅ 已完成 2026-10-21

- [x] `ProfileStore.getCurrentFacts()` / `getCurrentCharacterFacts()`：**当前认知的唯一出口**
      （`active && 未过期`）；旧名 `getActiveFacts` / `getActiveCharacterFacts` 保留为**同语义别名**（`@deprecated`）
- [x] `getAllFacts()` 文档改为「**仅审计**」，写明它导致过的两起错（E2 / E3）
- [x] `CronProcessor.deepProfile` 改读当前态（**E2**）；当前态为空 ⇒ **不重写** `basics`、记 warn
      （拿空输入重写会把已知印象洗成空白）
- [x] `RealtimeProcessor` 纠正候选池 / `MemoryManager.applyCorrectionFastPath` 改读当前态（**E3**）
- [x] `check-memory-eligibility.cjs` 的 `getAllFacts` 规则**转为默认拦截**（T3 落地后不再需要 `--strict`）
- [x] 红测：`tests/memory/current-state-reads.test.ts`（**4 条**，改前 4 条全红 → 改后全绿）
  - 用**真的 `ProfileStore`**（内存库）而非 mock：这条链路的错法就是"读错了那个方法"

## T4. 阶段独立记账（C4）—— ✅ 已完成 2026-10-21

- [x] `SessionEndResult` 改三段：`{ summary, facts, vector, reason? }`
      （`summary`/`facts` 是 `'ok' | 'failed' | 'skipped'`，`vector` 沿用 `VectorWriteOutcome`）
- [x] DB：`conversations.facts_status`（默认 **`'pending'`**，不是 'ok'）+ `facts_attempts`
- [x] `ProfileExtractor.extract` 返回 `{ facts, characterFacts, attempted, error? }` ——
      **"没调 LLM" / "调了失败" / "看了确实没有"** 三种可分（E5 的根）
- [x] `SessionEndProcessor`：提取结果落 `facts_status`（摘要行先以 `pending` 插入，之后补记）
- [x] `retryFailedFacts()`：只补事实，不重摘摘要、不重写向量；0 行更新不算成功
- [x] `MemoryManager.retryFailedFactExtraction()`：`archiveStaleSessions()` 里与摘要补偿并列调用；
      **D3 上限 1 次**（用尽后留 failed 且可见）
- [x] `onSessionEnd()` 返回三段结果；`archiveStaleSessions` 日志新增「事实提取失败 N」；
      `extractProfile()` 返回值加 `factsStatus`
- [x] **E6 的三处假成功全部改口**：`chat.ts` 的 `/clear`、`capabilities` 的 `/new`、
      `llm-agent` 的压缩钩子（原来 `.then()` 就当"摘要完成"，失败也会恢复截断 ⇒ 没被摘要的对话被丢掉）
- [x] 红/绿：`tests/memory/facts-retry.test.ts`（**4 条**，真 `MemoryManager` + 内存库）
  - 摘要成功 + 提取失败 ⇒ 库里 `facts_status='failed'`（改前这一列都不存在）
  - 补偿后转 `ok` 且**摘要没被重写**；D3 次数用尽后不再调 LLM
- [x] 既有用例按新形状更新（`session-end-result` / `ConversationStore-vector` / `session-summary-failure` /
  `synthetic-inflow` / `integration/processors`）—— 断言的**意图**没变，只是从"一个布尔"换成"三段"

> ⚠️ 工具纪律（本次踩过）：改 TS 源码**不要**用 PowerShell 的 `Get-Content -Raw` / `Set-Content`。
> 本机 `pwsh` 实为 **PS 5.1**，默认 ANSI（GBK）编码会把 UTF-8 中文整篇写坏（本次毁过
> `SessionEndProcessor.ts`，靠 `git checkout` 还原后重做）。用 `edit` / `write` 工具，或显式
> `-Encoding UTF8` 读写。

## T5. 派生谱系与重建（C3）—— ✅ 已完成 2026-10-21

- [x] DB：`user_profile.basics_source`（JSON：`{factKeys, factCount, generatedAt}`）+ `basics_stale`（0/1）
- [x] `ProfileStore.updateBasicsWithSource(basics, factKeys)`：写 `basics` 时**同时写谱系**并清 stale
- [x] `ProfileStore.getBasicsMeta()`：`{ stale, factCount, generatedAt, factKeys }`（纯数据）
      —— 坏 JSON 视为"无谱系 + stale"（宁可说过时，不假装新鲜）
- [x] **失效传播**：`addFact` / `addFacts` 的 supersede 分支、`supersede()`、`expireFact()`、
      `expireStaleFacts()`、`confirmFact(false)` 全部调 `markBasicsStale()`
      （**不同步重建**：重建要调 LLM，不能挂在写入路径上）
- [x] `PromptAssembler` **三档**（apply 时按"纠正后她真的不再坚持旧说法"细化）：
      新鲜 → `[关于你]`；stale **且有当前事实 → 整块不注入**（旧总结会和新事实打架）；
      stale 且无当前事实 → `[关于你（较早的印象，可能已过时）]`；读谱系失败按 stale 处理
- [x] `CronProcessor.rebuildBasics()` 成为**唯一重建入口**（cron 每轮 / Web 端按钮共用），
      `MemoryManager.rebuildBasics()` 委托它（纯数据返回 `{ok, usedFacts, stale}`）
- [x] 绿测：`tests/memory/basics-provenance.test.ts`（**4 条**）
  - 纠正 ⇒ stale；重建后 stale 清除且谱系只含当前事实；stale 时 prompt 降级标注；
    当前态为空 ⇒ **拒绝改写**（不把已知印象洗成空白）

## T6. 不自证（D2 落地）—— ✅ 已完成 2026-10-21

- [x] `ProfileFact.source` 新增 **`'reflection'`**（与 `inferred` 分开：前者她自己想出来的）
- [x] `recordReflection` 的 insight 标 `source='reflection'` 写入 `character_facts`
- [x] 绿测：`tests/memory/reflection-not-evidence.test.ts`（**4 条**）
  - insight 落【关于我】且 `source=reflection`
  - **连续 3 天反思 ⇒ 人格参数零变化**（自证闭环的闸）
  - 反例校准：显式 `adjustments` 仍生效（闸拦的是"自述当证据"，不是拦掉所有调整）
  - 【关于我】里仍读得到她的自省（隔离 ≠ 清空）

## T7. 场景验证与收尾

- [x] 场景 S1–S6 已用**各自的测试文件**覆盖（不是一个大文件）：
  S1 纠正生效 → `basics-provenance`（stale 且有事实 ⇒ 整块不注入，旧说法不进 prompt）
  S2 她的话不调人格 → `eligibility-wiring`
  S3 合成注入两条路径都不进 → `eligibility-wiring`（E1 逐字相同）+ `synthetic-inflow`
  S4 事实失败补偿 → `facts-retry`
  S5 basics 只据当前态 → `current-state-reads` + `basics-provenance`
  S6 不自证 → `reflection-not-evidence`
- [x] 合并回 `openspec/specs/memory-system/spec.md` —— 作为 **§10 记忆资格与派生规则**（整节插入，无 `+`）
- [x] `check-spec-diff-residue.cjs` exit 0
- [x] 更新 `docs/Web-API-Design.md`（`extractProfile` 返回值加 `factsStatus` + 失败示例）
- [x] 更新 `docs/TODO.md`（导航行改为"T1–T6 已实现，待归档"）
- [x] 更新 `docs/HANDOFF.md` 顶部（新一节：2026-10-21 记忆资格收口 + 三条要记住的坑）
- [x] **已归档** 2026-10-21 → `openspec/archive/2026-10-21-unify-memory-eligibility/`
      （spec 合并为 `memory-system` §10、`specs/index.md` 最后变更已更新、residue 检查 exit 0）
- [ ] 真机验证（可选，**非阻塞**）：跑一段对话 → 纠正一条事实 → 看下一次 `assemble` 的输出里旧说法是否消失

## 明确不在本 change 内

- 存量数据清洗（`scripts/synthetic-data-audit.cjs` 已具备只读复验能力，另行安排）
- 召回系数（`tune-recall-with-runtime-data`）
- 人格参数与旋钮语义（`fix-memory-knob-regression` 已归档）
- Web 端"重建画像"按钮的 UI（本 change 只提供 `rebuildBasics()` 方法）

# 会话转接文档（2026-09-27 更新）

> 给下一个会话：**先读本文件**恢复上下文，再读 `openspec/specs/index.md` 看 spec 全貌。
> 治理流程见 `openspec/project.md`；部署凭据见 `docs/Docker-Deployment.md`（永不提交）。
> 已知但暂未修的缺陷见 `docs/KNOWN-ISSUES.md`（triage 入口，非 spec）。
>
> 本文件只写「现在什么状态 + 下一步做什么 + 别踩什么」。
> 每个改动的**实现细节在对应的 `openspec/changes/<name>/`**（已提交，可查）。

---

## 一句话状态（2026-09-27）

**存量已回填干净**（2026-09-27）：52 条占位符摘要全部重生成、40 条垃圾向量替换、
77 条缺失向量补齐。向量库 **2010 条**（chat 1470 / conversation 138 / life_event 402），
`summary LIKE 'Session %summary'` = **0**。

摘要管道已验证恢复（9-27 01:10：22 天来第一条真实摘要落库）。线上部署三次
（`00:45` 摘要解析 → `19:09` 窗口截断 → `23:11` 回填支持）。

**`tune-recall-with-runtime-data` 的阻塞已完全解除**：管道活着、数据干净，可以攒基线了。

**同时处理了一次凭据泄露**：服务器密码明文在公开仓库里躺了 28 天，已轮换作废。

**新前端 `packages/console` 已上线**（真数据 / 聊天流式 / Live2D / 同源托管）。

**模块化拆解已开工**（2026-10-01）：P1 完成（内核 + `AlysiaCore` 模块化），详见下一节。
另修掉一个**静默停摆 6 个月**的画像提取故障。
`master` @ `b7bdb28`（10-02 整理前）。**常规 965 全过**（含此前漏跑的 `dsh-adapter` / `dsh-console`）；
E2E（真 API）**5/5 全过**。

---

## 🧹 2026-10-02：治理债清理（22 个 change 补归档）

**起因**：`openspec/changes/` 里压着 **30 个** change 没归档，其中一批其实早就实现了——
典型的「apply 做了、archive 忘了」。本轮把它们走完 loop。

**已归档 22 个**（`git mv` → `openspec/archive/<完成日>-<name>/`）：
- **10-02 批（11）**：add-module-kernel / drop-kernel-peer / modularize-core-assembly /
  add-module-tests / modularize-server-assembly / externalize-life-prompts /
  fix-profile-extract-empty-response / fix-role-import-wipes-persona /
  connect-dsh-alysia-bridge / bridge-memory-read / record-dsh-as-coding-mode
- **09-25 批（11）**：adopt-nextjs-console / console-local-serve / drop-electron-desktop /
  add-life-readonly-endpoints / wire-console-chat / migrate-live2d-to-console /
  live2d-persist-across-pages / deploy-console-remote / server-bind-host /
  optimize-recall-pipeline / wire-importance-signal

### ★★ 四处 apply 是「假勾选」（任务勾了，spec 根本没合并）——已补做

| change | 实际缺口 | 补做内容 |
|---|---|---|
| `bridge-memory-read` | `dsh-adapter/spec.md` §2.2/§2.4/§4 **一字未动**，且 spec 写的是 **GET**、实现是 **POST** | §2.2 重写为已落地（缓存/预热/**dsh provider 同步**导致的 1 轮延迟）、§2.4 改为真工具、§4 整节改成「逐项销账」表 |
| `connect-dsh-alysia-bridge` | 同文件通篇仍是「二期」措辞，还有一句「dsh 插件侧的接入尚未做」（**已过时**） | §1/§2.5/§2.6 改写 + 删过时警告 + §5 补 dsh 对接硬约束 |
| `modularize-server-assembly` | `module-kernel` §5 无 server 侧内容；`alysia-architecture` 还写着「bootstrap.ts 仍是总装脚本 → **P3 范围**」（本 change 正是推翻它的） | 新增 `module-kernel` **§5.1**；architecture §2.1 目录树 + §2.2 改写 |
| `fix-role-import-wipes-persona` | `role-system/spec.md` §4.1 还是原来一句话，字段合并语义没进 spec | 新增 **§4.1.1 字段合并契约** + §7 变更记录 |

> **共性**：`index.md` / `HANDOFF.md` / `Web-API-Design.md` 都更新了，**只有 spec 那一步没做**——
> 于是出现「index 比 spec 新」的自相矛盾（`bridge-memory-read` 那条最典型：index 写 `POST /api/memory/read`，
> spec 写 `GET`）。**apply 的验收标准是 spec 里能读到那句话，不是任务框打没打勾。**

### 索引修正（`openspec/specs/index.md`）

- memory-system 行补 `optimize-recall-pipeline` / `wire-importance-signal`（**09-25 就没记**）
- alysia-console 行重写（漏 `wire-console-chat` / `deploy-console-remote` / 两个 Live2D change）
- webui-system / server-hardening / alysia-architecture 行补齐 change 名
- 修掉 alysia-architecture 行**缺一个 `|` 分隔符**的表格破损
- 📌 Backlog 移除**死链** `backfill-failed-session-summaries`（9-27 已归档，目录早没了）
- `clean-spec-diff-residue` 行**扩大范围**（见下）

### 没归档的（有意）

| change | 为什么 |
|---|---|
| worldbook-sampling-cooldown / add-platforms-endpoint / console-a11y-motion / tune-recall-with-runtime-data / add-ops-health-report / clean-spec-diff-residue | 6 个 `pending` backlog，**留着** |
| `build-alysia-console-plugin` | **进行中且上游已变**：原方案踩在已废弃的 `.agent-presets` 与桌面端不执行的 `tapIndex` 上；dsh-console 也只注册了「画像」一个 tab。**需重新判断范围** |
| `webui-visual-redesign` | **已被取代**：对象是 Vue 版 webui 的布局大改，而 webui 待废；且它自称「已完成(补录)」的那部分**在代码里查不到落点** |

### ★ 顺带查实的三件事

1. **`+ ` diff 残留的真实范围**比立项时记的大得多：`ai-life-system/spec.md` **约 42 行**
   （`worldbook-digest-summary` / `life-interval-narrative` / `chat-life-continuity` /
   `mood-side-analysis` / `worldview-crossworld-window` / `life-event-message-split` /
   `worldview-base-field` 等**多次 apply 层层累积**），不止 `memory-system` 那 5 行。
   ⚠️ **不能直接 `grep '^+'` 删**——里面混着 ASCII 树角字符 `+│` 与提示词模板正文。
2. **「删 `packages/webui`」的 change 从未建立**，而它是**真实且带耦合**的活：
   `server.ts` 的 `defaultDist`、`bootstrap.ts` 的 `IS_DESKTOP` 分支、webui 侧的 Live2D / 模型 / 署名残留。
3. **本机 shell 默认写不了工作区**（新坑，见下）。

### ⚠️ 新环境坑：沙箱内 shell 写不了工作区（低完整性）

**症状**：`git mv` / `git commit` 报 `.git/index.lock: Permission denied`；
连 `Set-Content` 到 `openspec/` `.git` `docs` 都「访问被拒绝」——**唯独工作区根目录能写**。

**真因**：工作区根目录被标了 **Low Mandatory Level（低完整性，带 `(OI)(CI)(NW)`）**，
而仓库里**原先就存在的子目录全是中等级别**（完整性标签只对**新建**的子项继承，老目录不回溯）：
**低完整性进程不能往高完整性对象写**（no-write-up）。

**口径**：
- 内容编辑走**文件工具**（edit / write）**不受影响**——它在宿主机进程里跑。
- 需要 shell 写文件的操作（`git mv` / `git commit` / 脚本改文件）**得放宽一次权限**
  （`danger-full-access` 一次性重试），或把会话切到**完全权限**。
- 别急着 `icacls` 全仓 relabel 成 Low——那是**降低整个仓库的完整性级别**，副作用没评估过。

---

## 🔧 2026-10-01 起：模块化拆解（进行中）

**背景**：dsh 出了桌面端并换代了插件机制，alysia 现有的两处 dsh 集成**全部失效**
（`.agent-presets/` 已废弃、persona section 改名 `deployment:persona-prefix`、
桌面端 `tapIndex` 不执行、desktop profile 根本不加载 web profile 的插件）。
用户拍板：**先在 alysia 内部把主 agent 拆成可插拔模块（a），再包装成 dsh 插件（b）**。

- **设计文档**：`docs/dsh-plugin-architecture.md`（dsh 插件原理 + 硬约束 + 拆解设计 + 模块清单）
- **回滚点**：tag `pre-modularize`（已打）
- **spec**：`openspec/specs/module-kernel/spec.md`
- **测试基线**：**818**（core 566 + server 192 + 其它包）

| 期 | 内容 | 状态 |
|---|---|---|
| P0 | 建 `core/src/kernel/`（Module 契约 + ModuleHost） | ✅ 完成（`add-module-kernel`） |
| — | 删掉依据错误的 `peer` 机制 | ✅ 完成（`drop-kernel-peer`） |
| P1 | `AlysiaCore.start()` 改成「注册 13 个模块 + 跑 host」，公开面逐字不变 | ✅ 完成（`modularize-core-assembly`） |
| — | 修画像提取静默停摆（4 个缺陷，见上节） | ✅ 完成（`fix-profile-extract-empty-response`） |
| P2 | 13 个模块各补单测（28 用例） | ✅ 完成（`add-module-tests`） |
| P3 | server 侧 `bootstrap.ts` 拆成 **10 个模块**（config/logging/core/vision/adapters/proactive/life/reminder/cron/webui）+ 抽 `PushChannel` | ✅ 完成（`modularize-server-assembly`） |
| P4 | 提示词资产搬到 `src/prompts/`（**有意不做 `.md`**，判据见 `prompts/README.md`）+ 7 条守卫 | ✅ 完成（`externalize-life-prompts`） |
| 二期-a | dsh bundle 化：`dsh.bundle.patch` + 昔涟 preset 声明（**派生自 standard**，保住工具集）+ 人设走 `{{alysia_persona}}` 变量可切换 | ✅ 完成 |
| 二期-b | 双进程通道（alysia server 侧）：`POST /api/ingest`（写）+ `GET /api/persona/prompt`（读） | ✅ 完成（`connect-dsh-alysia-bridge`） |
| 二期-c | dsh 插件侧接入：人格缓存刷新 + 对话回传 + 会话结束触发结算 | ✅ 完成 |
| — | 修 `importRole` 清空人设（见下节，线上 bug） | ✅ 完成（`fix-role-import-wipes-persona`） |
| — | **记忆读通道**（用户报「记忆没继承」，查出读通道从来没接） | ✅ 完成（`bridge-memory-read`） |

### ★ 2026-10-02：记忆读通道补齐 + 一个测试配置遗漏

**用户报「记忆没有继承」**。排查结论：**不是坏了，是读通道从来没接**——
`alysia:memory` context provider 和 `recall_memory` 工具**两条都还是 2026-08-25 的 MVP stub**。
写通道反倒是好的（`dsh:session-*` 19 + 7 条已入库）。

补齐：server 端 `POST /api/memory/read`（与聊天管线**同一套组装**）+
插件端「缓存 + **挂载预热**」+ `recall_memory` 真工具。

⚠️ **dsh 的 prompt provider 是同步的**（`assemble()` 虽 async 但 provider 调用点无 await），
所以记忆只能给缓存——**预热**让第一轮就有 `[关于你]` 那份画像，
查询相关的 `[相关记忆]` 慢一拍（要即时的让她调 `recall_memory`）。

### ★ 2026-10-02：**编程模式回来了，由 dsh 承接**

`CLAUDE.md` 的原始定位是「聊天 + 编程双模式，编程模式携带聊天积累的人格/记忆」；
但 `alysia-architecture` 记的是「砍掉编程模式」——因为自建 Electron 壳 9-25 砍了，
**编程模式一直空着**。

现在四项都对上了（人格 / 记忆 / 新积累回流 / 对标 Claude Code 的工具集），
**只是载体换成了 dsh**。已写进 `alysia-architecture` §1.1 与 `CLAUDE.md`
（change: record-dsh-as-coding-mode）。

**顺带修了一个真实缺陷**：dsh 回传的 `source` 标成了 `'chat'`，
而 `EventSource` **本来就有 `'code'`**，且 `RealtimeProcessor:41` 已按它分流：

```ts
const mode = event.source === 'code' ? 'code' : 'chat';
await this.worldbookMatcher.match(text, mode);
```

→ 在 dsh 里干活的对话**按闲聊的 scope 匹配世界书**（`chat` 条目误触发、`code` 条目匹配不到）。
已改为 `'code'`。语义上 `'code'` 指**来源环境**（dsh 是编程环境），不是话题分类。

**2026-10-02 preset 改名**：我们的 preset 从「昔涟」改为**「昔涟 · 标准」**
（id `alysia` → `alysia-standard`，Loader 行 `preset-alysia` → `preset-alysia-standard`），
并成文命名约定 `preset-alysia-<模式>` / `alysia-<模式>` / `昔涟 · <模式>`——
为了后续能加「昔涟 · PTC」「昔涟 · Cordis」而不混淆（用户拍板方案 a：与出厂模式并存）。

⚠️ **改 id 的副作用**：此前用 `alysia` 开的会话会引用一个已不存在的 preset。
都是测试会话，重启桌面端后重新选一次即可。

**顺带发现一个测试配置遗漏**：根 `vitest.config.ts` 的 `projects` 只有 core/server/console，
**`dsh-adapter` / `dsh-console` 从来不跑**——本会话此前报的所有「全仓 N 全绿」
都**不含**它们。已补上，**真正全仓 = 958**（不是 889）。

### ★★ 2026-10-01 修复：她的**人格核心从未进入 system prompt**

排查 dsh 读通道为什么返回 0 字时挖出来的——**读通道没坏，是数据本来就是空的**。

```
启动顺序：seedPersona()（写入 soul.md 36KB 人设）
       → loadRolePackages()（导入 stickers*.json，role 都是 'alysia'）
       → upsertRole 整行 UPDATE，包没提供的字段填空默认 → system_prompt 被清成 ''
```

`PersonaStore.get()` 会给空的 `tone`/`speech_style`/`emotional_range` 自动填回**结构默认值**
（所以它们看着是好的，其实是默认参数）；`system_prompt` 没有兜底，**只有它露馅**。

**与迁移指南坑 #7 同族**：那次修的是「`DELETE WHERE role=?` 误删世界书」，persona 这半没修。

修复后实测：`system_prompt` 0 → **36351 字**；`GET /api/persona/prompt` 0 → **6375 字**。

⚠️ **注意行为变化**：人设核心（紧凑形式 ~6.4KB）**第一次真正进入 system prompt**。
她此前靠世界书（101 条背景设定）撑角色感，现在人设也在场——**回复风格可能有可见变化**，
且每轮多 ~6.4KB context。观察几天再决定要不要调 `getCompactPersonaPrompt(n)` 的节数。

### ★ 二期-b 的关键发现（省下重做）

- **会话结算不用新建**：`POST /api/sessions/:id/extract` **就是**
  `sessionEndProcessor.process()`（摘要 + 画像 + 人格确认 + 固化）。
- **来源标记用 session 前缀**（`dsh:…`），**不给 `EventSource` 加枚举值**——
  加了会让所有 switch 它的下游出现未覆盖分支。
- **`/api/ingest` 只收 `dsh:` 前缀**：写接口不该能往 QQ/WebUI 会话注入消息。
- 通道已用**隔离 dataDir** 真启动验证过（**没写进生产库**）：
  读通道 4 节/6375 字，写通道事件真的落库（`dsh:sess-smoke` 3 条）。

### ✅ 已修复：画像提取长期静默停摆（2026-10-01，change: fix-profile-extract-empty-response）

`cron.test.ts` 曾是既有失败（`expected '{}' not to be '{}'`）。系统排查后挖出 **4 个独立缺陷**：

| # | 缺陷 |
|---|---|
| A | `profile.extract.max_tokens: 1024` 对推理模型太小 —— 9-25 修 `session.summary`（512→2048）时**漏掉的同源槽位** |
| B | `ProfileExtractor` 裸 `catch {}`（该文件连 logger 都没 import） |
| C | `CronProcessor.deepProfile` 裸 `catch {}` |
| D | `OpenAILLMService.complete` **只声明两个形参**，静默丢弃 `ILLMService` 约定的第三参 `sampling` —— 整套分槽机制对该实现失效 |
| E | `MemoryManager.sampling` 缺省 `undefined` → 所有场景塌成同一个槽 |

**后果**：用户说过的所有事实（城市/职业/技术栈/习惯）从未进入画像，
`PromptAssembler` 的 `[关于你]` 段永远为空——**她其实不认识你**。

修复后 `basics` 产出真实画像，`facts` 0 → 7，E2E **5/5 全过**。
契约已固化进 `openspec/specs/memory-system/spec.md` §4.1.1（4 条），并有测试守卫。

⚠️ **历史数据未回填**：线上 `basics`/`facts` 仍是长期空/稀疏的，
本修复只保证从此往后正常。要不要回填需单独评估（重跑历史 `onSessionEnd`）。

**跑 E2E**（要真 API，花真钱）：

```bash
cd packages/core
set -a && source <(tr -d '\r' < ../../.env) && set +a
export PATH="/e/nodejs24:$PATH"
npx vitest run tests/memory/e2e          # 现在 5 passed / 4 files
```

### ⚠️ 已知取舍：`stop()` 不关 SQLite / LanceDB

`core.stop()` 只停 EventBus，不关 DB 句柄——所以 Windows 上临时目录删不掉（EPERM）。
这是**重构前后一致**的现有行为（P1 刻意没改，见 change proposal 决策 2）。
修复归独立 change `unify-core-shutdown`。

### ★★ 2026-10-02 事故：preset 改名打断全部已有会话

把我们的 preset id 从 `alysia` 改成 `alysia-standard`（为后续「昔涟 · PTC」铺路）后，
**所有引用过旧 id 的会话全部打不开**，报 `unknown agent preset: alysia`。

**id 是持久化契约** —— 写进会话 header（`agentPreset`）和会话日志的
`agent-preset/selected` 事件；改名的报错**不会提示「它被改名了」**。
显示名 `name` 随便改（不持久化）。

代价：**16 个 dsh 会话全删**（用户确认无实质任务）。

诊断方法值得记：**dsh 会话日志是可读的**（`~/.dsh/sessions/<工作区>/session-*/session.v4.jsonl.zstd`
是**多帧 zstd**，按 `28 B5 2F FD` 魔数切帧逐段解压）。里面有**模型看到的完整 system prompt** ——
比猜强太多。本次就是靠它确认了「会话切到过 `alysia`」。

### ★ P0/P1 的核心教训（别重蹈）

1. **「全绿」不等于「有覆盖」**——`AlysiaCore` 此前**没有任何测试**，`start()` 是测试盲区。
   动手前先补了冒烟测试并在**未改动的代码**上验证它绿，才是真安全网。
2. **「我觉得有环」必须先读代码验证**——`peer` 机制的整个依据（Coalescer ↔ EventBus 双向依赖）
   是我推断的，实际 `EventBus.ts` 全文不引用 Coalescer。已删，见 `drop-kernel-peer`。
3. **最危险的重构破坏是不报错的那些**——`al:pipeline` 里 Coalescer 必须是**同一个实例**
   （既在 `PipelineContext` 又在 stage 列表）。拆成两个后管线照跑，只是打断永久失效。
   已加断言守住（`tests/index.smoke.test.ts`）。

⚠️ **跑测试必须换 node**：PATH 里的 node 是 v20，better-sqlite3 ABI 不匹配会满屏失败
（看起来像代码坏了，实际不是）。用 `/e/nodejs24/node`（v24.19.0）：

```bash
export PATH="/e/nodejs24:$PATH" && npx vitest run --exclude='tests/memory/e2e/*'
```

⚠️ **P1 是风险点**：改 `AlysiaCore.start()` 时行为必须逐位一致。验收基线见
`openspec/specs/module-kernel/spec.md` §5——尤其 **`bootstrap.ts:246` 覆盖 `index.ts:305`
的 reminder 工具**这个隐性行为（`ToolRegistry` 的 Map 同名覆盖），迁移时不能丢。

⚠️ **peer 的代价**：互相 peer 的模块同期安装，**单元内 inject 不校验**，
必须延迟接线（`ctx.on/emit` 握手或使用时再 `ctx.get`）。Coalescer ↔ EventBus 就是这个形状。

---

## ⚡ 下一步（按优先级）

### 1. ✅ 摘要管道已验证恢复（2026-09-27 01:10）

**22 天来第一条真正生成的会话摘要已落库。** 证据链：

```
01:09:47  cron 触发
01:10:03  [SessionEnd] important_moments 回填 3/3 条   ← 失败路径走不到这里
01:10:06  [Memory] archived 1/1 sessions

库里: [ok] 23条 2026-09-26T17:10:03Z  ✅ 真实摘要
      "中秋前后两天，昔涟独自在乡下小院过节…"
      summary_status='failed' = 0
```

⚠️ **别只看日志判定**——这次是运气好（日志和数据一致）。上次 `archived 1/1` 骗了 18 小时。
**判定一律查库**。

### 2. ✅ 存量回填已完成（2026-09-27）

52 条占位符摘要重生成 + 40 条垃圾向量替换 + 77 条缺失向量补齐，全部经生产库验证。
细节见 `openspec/archive/2026-09-27-backfill-failed-session-summaries/`。

⚠️ 过程中踩了一个**同类型**的坑：回填脚本给 `ConversationStore` 传了 `null` vectorStore，
于是「52 条摘要全更新成功、40 条垃圾向量一条没换」，而日志全绿。**第四次**
「成功日志掩盖了没做的事」（前三次：占位符伪装摘要、存活伪装健康、空转伪装归档）。

### 3. `tune-recall-with-runtime-data` —— **阻塞已解除，可以开始攒数据了**

原计划是"部署 → 攒一周 → 调系数"。**摘要修复已上线**，所以现在攒出来的基线是干净的
（带着那个 bug 攒的话，垃圾向量会污染召回相似度分布）。

⚠️ 但仍要**先积累再调**：`[Recall]` 日志要等新版跑起来才有（旧镜像没这行）。

### 4. 其它 backlog

| change | 状态 |
|---|---|
| `add-ops-health-report` | 日报/监控。**用户 9-25 决定先记档后做**；前置：日志系统先整理（96.6% 是 QQ 噪声） |
| `clean-spec-diff-residue` | `specs/memory-system/spec.md` 残留 5 行 `+ ` 标记——**已两次让校验工具给出错误结论** |
| `console-a11y-motion` | 17 处动画缺 `prefers-reduced-motion`；用户指示先记档 |
| `add-platforms-endpoint` / `worldbook-sampling-cooldown` | 老 backlog，未做 |
| `play_live2d_action` 工具 + 输出驱动状态切换 | `window.live2d` 接口已就绪，未做 |
| 表情包渲染 `[表情包:名字]` | console 未接（现按纯文本显示），webui 有 |
| `soul.md` 的「Live2D 桌面空间」 | Electron 已砍，表述与实际不符。**用户决定另开 change 改** |
| 删 `packages/webui` | 三个删除约束全解除，但**不是纯删**（`server.ts` 的 `defaultDist`、`bootstrap.ts` 的 `IS_DESKTOP` 分支） |

### 5. 一个没查完的线索

`proactive.personalize` 槽 `max_tokens: 256` —— 按推理模型的账**比 512 更可疑**，
但日志里 proactive 看着是正常的，**没证据**。要么查，要么放着。

---

## 本会话（9-25 ~ 9-26）做了什么

| change | 一句话 |
|---|---|
| `fix-credential-leak-in-sync-script` | 服务器密码硬编码在公开仓库 28 天 → 已轮换 + 凭据外置到**仓库树外** |
| `fix-session-summary-silent-failure` | 会话摘要 22 天 100% 失败 → 失败不再伪装成成功 + 推理模型预算 |
| `fix-session-event-window-truncation` | 部署后验证发现：`getBySession` 取最旧 1000 条 → 归档空转 → 改取最近 N 条 + 空转可区分 |

**外加三个 backlog 立项**：`backfill-failed-session-summaries` / `add-ops-health-report` /
`clean-spec-diff-residue`。

### 🔴 事故一：凭据泄露（已闭环）

提交 `05a2651`（8-28）把服务器 sudo 密码明文写进 `sync-from-server.sh` 第 11 行，
随**公开仓库**暴露 28 天。核验该密码**同时是 `hexi` 的登录密码**（非独立 sudo 密码），
且 `passwordauthentication yes` → 危害链是「读仓库 → SSH 登录 → sudo root → 读 .env 与全库」。

**已处理**：密码轮换（旧密码验证失效）、核验无入侵迹象（`last` 仅 admin/root 止于 8-12；
`lastb` 全是公网爆破噪声）、仓库侧凭据外置。

**遗留**：SSH `passwordauthentication` 建议改 `no`（纵深防御，但有锁死风险，**需用户确认**）；
pre-commit 凭据扫描另立项。

### 🔴 事故二：会话摘要静默失败（22 天）

**证据链**：库里 134 会话，**最后一次真摘要是 9-03**；日志 `[SessionEnd] summary LLM failed`
4/4；镜像 9-01 构建、容器 ~9-04 重启 —— 严丝合缝。

**根因（真实 API 实测确认，非推测）**：`CHAT_MODEL` 是**推理模型**，
**reasoning 与可见内容共用同一个 `max_tokens`**，每次先花 ~250 tokens
（实测 `reasoning_tokens=242`）。512 的预算下对话稍长即"预算耗尽、content 为空"（HTTP 200、0 字）。

**这同一个 512 是两处故障的共同根因**（原以为是两个独立问题）：
- `session.summary` 槽 → 会话摘要 22 天 100% 失败
- `life.generateSummary` 槽（每日反思引用）→ 7 天 11 次 empty response

**触发点**：`b9c845d`（8-28 加 `character_perspective` 字段）→ reasoning 越界 → 成功率 55% → 0%。

**修复**：抽共用 `utils/llm-json.ts`；两个槽位 512 → 2048 + `response_format`；失败重试 1 次；
**失败不写占位符**（`summary=''` + `summary_status='failed'` + **不 embed**）；cron 自动补处理。

### 🔴 事故三：事件窗口取错端（**部署后才暴露**）

上一轮修完**部署上线**，容器跑 18 小时、cron 三次，**库里 0 条新摘要**，而日志一路报
`archived 1/1`（看着完全正常）。

**根因**：`EventStore.getBySession` 是 `ORDER BY created_at ASC LIMIT 1000` —— 取**最旧**的
1000 条，而调用方要的是"最近的会话内容"。主会话积累到 1436 条事件后，anchor 之后的事件
**一条都取不到** → `process()` 早退 → 空转。

**★ 这条推翻了事故二的归因**：此前把"最后真摘要是 9-03"归因于 8-28 的字段改动 + 9-01 部署；
实际该会话第 1000 条事件正是 **2026-09-03T01:26**，最后一条真摘要是 03:45。
**9-03 是"撞上 1000 上限"的日子。**

**修复**：`getBySession(sessionId, {limit?, since?})` 改为「最近的 N 条、可 `since` 过滤、
升序返回」，窗口过滤**下推到 SQL**；`process()` 返回 `SessionEndResult{summarized, reason}`，
`archiveStaleSessions` 按真实结果计数并区分「跳过/失败」。

**教训（最重要的那条）**：`archived++` 无条件自增，让"什么都没做"和"归档成功"在日志里
长得一模一样。**降级/空转必须可区分**——这是本项目第三次栽在同一类问题上
（占位符伪装成摘要、存活检查伪装成健康、空转伪装成归档）。

---

## ⚠️ 关键约定（勿踩）

1. **OpenSpec 流程**：任何行为变更（含前端）先 `/openspec-change` 建骨架 → 实现 →
   合并 spec → 归档 → 更新 index.md。**禁止直改不 archive**。
2. **敏感审查**：提交前检查。**凭据一律放仓库树之外**（`$HOME/.alysia-deploy-credentials`）——
   树内文件 + gitignore 只是"约定"不是"保证"，`docs/Docker-Deployment.md` 自身就是反例。
3. **不静默吞错**：外部交互必须检查响应体 + 打日志。
   ⚠️ 但也要注意**降级不等于可见**——`catch → 存默认值` 会把故障伪装成成功，
   摘要那 22 天就是这么丢的。**要进长期记忆的数据，失败宁可不存也不要存垃圾。**
4. **改配置只改 `packages/server/config.yml`** —— 根目录那个 `config.yml` **是死文件**，
   改错**没有任何提示**。
5. **聊天回复「想告诉轻月：」句式**是接受的设定，不要"修"它。
6. **★ 推理模型的 max_tokens**：`CHAT_MODEL` 是推理模型，**reasoning 与可见内容共用预算**。
   结构化输出槽位必须 ≥1024，否则会得到 HTTP 200 + 空内容。
   **单测抓不到**（LLM 是 mock 的）→ 改 prompt / 换模型 / 调采样后**跑
   `packages/server/scripts/verify-session-summary-fix.ts`**（真实 API 探针）。
7. **★ 计数类日志必须反映真实结果**：`archived++` / `summaryGenerated: true` /
   `{"status":"ok"}` 这类**无条件成功值**是"静默故障"的温床。本项目已栽三次：
   占位符伪装成摘要、存活检查伪装成健康、**空转伪装成归档**。
   凡是"成功/完成"的日志，都要问一句：**失败路径会不会走到这里？**
8. **★ 部署后的验证必须查数据，不能只看日志**：事故三就是被 `archived 1/1` 骗了 18 小时。
   判定标准写进「下一步」了。
9. **★ spec 里有残留的 `+ ` diff 标记**（`memory-system` 末尾 5 行）。任何基于
   `grep '^+ '` 的合并/校验都会被它带偏——**合并后用"删掉插入段应逐字节还原"来验证**，
   别只数行数。

---

## 环境速查

| 项 | 说明 |
|----|------|
| **本地跑 server** | `cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx src/bootstrap.ts` |
| **★ 本地跑测试也要 Node 24** | `PATH="/e/nodejs24:$PATH" npx vitest run`。PATH 里的 node 是 v20，**better-sqlite3 ABI 不匹配 → 满屏测试失败**（看起来像代码坏了，其实不是） |
| **前端开发** | `pnpm dev:console`（3000，rewrites 代理 /api → 6185）。**必须用 corepack**：根 pin 了 pnpm@9.15.0 |
| **前端本地部署** | `pnpm build:console` → 起 server → `http://localhost:6185` 直开 |
| **★ core 改动必须 build** | `cd packages/core && npm run build` —— server 走 tsx 跑 src，但 `@alysia/core` 走 symlink 的 **dist/**。不 build 你的改动**完全不生效且不报错** |
| 测试 | `pnpm --filter @alysia/{core,server,console} test`（core e2e 要 `--exclude='tests/memory/e2e/*'`） |
| **本地免鉴权** | `packages/server/config.yml` 设 `host` 会**破坏部署**（见下）。本机想只绑回环请在**根目录 `.env`** 写 `ALYSIA_HOST=127.0.0.1` |
| 鉴权边界 | 钩子**只守 `/api/*`**，静态资源与页面公开 |
| 前端分流 | 服务模式 → console；`ALYSIA_DESKTOP=1` → webui（UI-only，已无 Electron 壳） |
| 服务器 | `hexi@121.41.111.120`（阿里云）。宿主机端口 **6186** → 容器 6185 |
| 服务器凭据 | `$HOME/.alysia-deploy-credentials`（仓库树外）。轮换密码后**同步更新它** |
| 服务器库备份 | `~/alysia/data/alysia.db.bak-*`（`before-summaryfix` / `before-windowfix` / `before-backfill`） |
| 回滚（两个锚点） | `sudo docker tag server-alysia:<tag> server-alysia:latest && sudo docker compose -f ~/alysia/compose.yml up -d`<br>`rollback-20260901` = 9-01 老版；`rollback-20260926a` = 只有摘要解析修复；`rollback-20260927` = 无 until/回填 |
| **部署后必须查数据** | 别只看 `archived N/N` 或容器 healthy（见约定 7/8） |
| 数据 | 服务器 `~/alysia/data` 卷挂载；迁移一律 **ALTER TABLE + try-catch 不 DROP** |

### ★ Docker 代理坑（2026-09-26 踩到并修复）

**症状**：`docker compose build` 报 `ECONNRESET` / 拉镜像 `connection refused`，
看起来像网络问题或墙。

**真因**：Docker Desktop 的代理配置（`%APPDATA%\Docker\settings-store.json` 的
`OverrideProxy*` / `ContainersOverrideProxy*`）指向 **`127.0.0.1:7890`** ——
那是**旧版 Clash for Windows** 的端口。当前用的 **Clash Verge 是 `mixed-port: 7897`**。

**已修**：6 处 `7890` → `7897`（改前备份了 settings-store.json）。
⚠️ 改这个文件**必须先 `docker desktop stop`**，否则 Docker 退出时会覆盖回去。

**排查口径**：`netstat -ano | grep LISTENING | grep 789` 看代理实际端口，
别假设还是 7890（`~/.claude/skills/clash-proxy.md` 里写的 7890 已过时）。

### 排查渲染问题的工具（零安装）

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
"$EDGE" --headless=new --virtual-time-budget=9000 --dump-dom "URL"        # JS 执行后的 DOM
"$EDGE" --headless=new --window-size=1440,2600 --screenshot=out.png "URL" # 截图
```

**⚠️ 大坑**：`--virtual-time-budget` 会**快进时间、破坏 rAF 驱动的渲染** ——
截图显示空白但页面其实是好的，**别据此误判**。要真实等待就用 CDP。

---

## 上一会话（8-29 ~ 9-01）完成 — 全部已归档

生活系统：**锁续期调度重构 → 公共底色集中 → L3 每日反思闭环**。

| change | 内容 |
|--------|------|
| `cr-p0-webui-auth` / `cr-p0-delete-cleanup` / `cr-p0-session-isolation` | CR P0 三件套 |
| `life-schedule-renewal` | 锁续期调度（修 33h 停摆）；时段保底；chat 上限 5→20 |
| `worldview-fixed-setting` / `worldview-centralize` | 跨世界之窗定位为固定设定 |
| `life-reflection-loop` | 每日反思：跨天 → LLM 反思 → adjustments 走护栏调人格 / insight 进画像 |

### ⚠️ 那批"待观察"项已过期 26 天，需重新确认

每日反思首跑 / 锁续期密度 / 跨世界之窗生效 / 意图推送句式 —— 等本次部署后再看。

**已知的一条**：本地实例的 `/api/life` 曾显示 `updatedAt` 停在 9-03、`events` 空 ——
但**起服务后立刻恢复**。所以那不是数据坏了，是**没起服务**。

---

## 系统现状（她的一天应该长什么样）

```
白天: internal 1h 节奏（生活积累）+ chat 3-8 条/天（推送,20 上限 + 1h 冷却）
夜间 0-7h: 2h 节奏（睡觉/安静,模型想聊可提前到 0.5h）
跨天: 每日摘要 + 每日反思（她复盘自己 → 人格微调 + 洞察进画像）
公共底色: 跨世界之窗（固定设定）/ 独立生活 / 生活中心——persona/worldview.md 唯一数据源
```

## 架构速览（多形态）

```
@alysia/core        记忆 / 人格 / 生活 —— 唯一实现，所有形态共享
packages/server     把 core 包成进程：adapters + /api/* + 托管前端

接入面（同一个 eventBus.put 入口 → 同一条管线）：
  QQ / Telegram      adapters/
  Web 前端           console（现行）/ webui（待删）
  dsh 插件           dsh-adapter（人格接入）/ dsh-console（反代 6185）
```

**会话模型**：一个会话一直用（Web `sess-<ts>` / QQ 按用户），
靠**每 6h 的增量摘要归档**处理"永不结束的会话"。
上下文三层：短期 40 条/24h 窗口 → 长期增量摘要 → 向量召回。

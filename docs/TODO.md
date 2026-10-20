# 待办总表（导航层，不是正文）

> 建立于 2026-10-18。**定位：唯一能回答"现在还剩什么没做"的入口。**
>
> 存在的理由：待办散在三处 —— `docs/KNOWN-ISSUES.md`（64KB，26 条 KI）、
> `openspec/specs/index.md` 的 📌 Backlog（一张大表，单元格里塞整段论证）、
> `openspec/changes/**`（11 个）。**没有一处能一眼看完在办清单**，
> 结果就是"修好的条目继续躺在待办里、未修的条目被当成已修"
> （2026-10-18 本次整理时，我自己就把已修的 KI-14/15/21 读成了未修）。

## 规则（防止本表退化成第四个影子文档）

1. **只做导航**：每条一行，正文永远在原处。这里**不写**现象/证据/论证。
2. **不新建编号**：沿用既有 ID（`KI-xx` / change 名），避免两套 ID 漂移。
3. **权威顺序**：`openspec/changes/<name>/proposal.md` > `docs/KNOWN-ISSUES.md` > spec 的 Backlog。
4. **新增待办**：先落原处（KI 登记册或开 change），**再回本表加一行**。
5. **销账**：改原处 + 删本表这一行。顺序反过来必然漏。

## 图例（"卡在谁"）

| 标记 | 含义 |
|---|---|
| 🧑 | 需要你拍板 / 你手上才有数据 |
| 🤖 | 我可以直接做，无需额外输入 |
| ⏳ | 等运行数据，**没数据不许动**（本项目纪律） |
| ⏸ | 明确决定暂不做 |

---

## A. 静默失败族（6 条，根因见 [SILENT-FAILURE.md](SILENT-FAILURE.md)）

> 其中 **3 条已收进 change [`harden-silent-failures`](../openspec/changes/harden-silent-failures/proposal.md)**
> （2026-10-18 新开，**不含** KI-11 / KI-1 / KI-2 —— 它们各自有 change 在等数据）。

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| KI-5 | 裸 `catch {}` 存储层已清，**其余 4 处未清** | 🤖 已立项 | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-25 | dsh 去重键取 `event.seq`，`seq` 跨重启是否重数**未证实** | ⏳ 已立项（只取证，不换键） | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-26 | 「无历史摘要 + 消息全早于 24h」⇒ 那批消息**永不进摘要** | 🤖 已立项 | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-11 | 52/55 写入点无 `.changes` 判据（观测已上线） | ⏳ 等 `[WriteTrace]` 分布 | [tune-zero-row-checks](../openspec/changes/tune-zero-row-checks/proposal.md) |
| KI-1 | `life.generateEvent` 无 `max_tokens` | ⏳ 等 `[LLM]` 数据 | [decide-life-event-max-tokens](../openspec/changes/decide-life-event-max-tokens/proposal.md) |
| KI-2 | `proactive.personalize: 256` / `vision.describe: 200` 未校准 | ⏳ 同上（并入同一 change） | 同上 |

## B. 契约 / 边界缺陷（**无 change**，可直接立项）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| KI-10 | 内核缺「只排序、不依赖服务」的表达（`after?`） | ⏸ 结论是「现在只有 1 处，不值得加」，**记着待观察** | [KNOWN-ISSUES #KI-10](KNOWN-ISSUES.md#L392) |
| **KI-27** | `processed` 位掩码**只写不读**：唯一读它的 `getUnprocessed` 只有 `compactOldEvents` 自己调用 ⇒ compaction 不是"放弃学习"，只是清积压。处置二选一：**赋语义**（各处理器按位判重）/ **删一半**（删位掩码与 getUnprocessed） | 🧑 待定方向 | [KNOWN-ISSUES #KI-27](KNOWN-ISSUES.md) |
| ~~KI-3~~ ✅ | **2026-10-20 已修**（`unify-memory-llm-client`，与 KI-9 同根因）：抽出唯一实现 `MemoryLlmClient`，`OpenAILLMService` 降级为适配器；契约测试锁住「同一 slot ⇒ request body 逐字相同」。★ 顺带纠正了本条前提——KI-21 之后两者**已不一致**（生产有超时/观测，测试那个没有） | — | [KNOWN-ISSUES #KI-3](KNOWN-ISSUES.md#L86) |
| ~~KI-7~~ ✅ | **2026-10-20 已修**（`make-stop-really-stop`）：`/stop` 接 `AbortRegistry.abort()`；★ 顺带修了「无论有没有在飞都回『已停止』」的假回话 | — | [KNOWN-ISSUES #KI-7](KNOWN-ISSUES.md#L375) |
| ~~KI-8~~ ✅ | **2026-10-20 已修**（`remove-dead-root-config`）：根目录死文件已删；★ 取证发现 `.gitignore` 的 `config.yml` 无斜杠 ⇒ 任意层级忽略，所以那份**从未被 git 跟踪** | — | [KNOWN-ISSUES #KI-8](KNOWN-ISSUES.md#L384) |
| ~~KI-9~~ ✅ | **2026-10-20 已修**（同上 change）：生产改用正式类，适配器不再是第二套实现 | — | [KNOWN-ISSUES #KI-9](KNOWN-ISSUES.md#L403) |
| ~~KI-18~~ ✅ | **2026-10-20 已修**（`guard-session-extract-endpoint`）：形状 400 / `dsh:unknown` 400 / 零事件 404 | — | [KNOWN-ISSUES #KI-18](KNOWN-ISSUES.md#L414) |
| ~~向量检索静默退化~~ ✅ | **2026-10-19 已修**（`fix-empty-embed-query`）：不是 API 变更，是**空查询**（`query=""`）也去请求 embedding ⇒ 智谱 `400 code 1213`。现在空查询直接走文本检索、`al:embed` 对空文本不发请求 | — | [spec §7](openspec/specs/memory-system/spec.md) |

## C. 能力机会（不是缺陷，是"要不要做"）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| ~~B1 recall-weight-formula~~ ✅ | **2026-10-20 决议：不实现**（`ratify-recall-weighting`，已归档）。不是"没数据"，而是旧公式 `向量×0.5+时间×0.3+重要性×0.2` 是**全局绝对分** —— 9-25 实测 46 条 life_event 全被 conversation 挤掉、尽管路内第一，就是跨源比分造成的。★ 通用判据：**跨来源禁止全局加权求和，权重只在路内用**。观测（`[Recall] …`）早已上线，调系数等数据 | ✅ 已决（ratify） | [spec §7](../openspec/specs/memory-system/spec.md) |
| ~~B2 knobs-into-recall~~ ✅ | **2026-10-20 已接 `retention_bias`**（`wire-retention-bias-into-recall`，已归档）：先补 valence 数据源（`metadata.polarity`，判不出记 0 不猜、只对新事件），再接 `score×(1+bias×polarity×0.1)` + `[Recall] 极性调整×N`。★ 力度 0.1 是**被单测逼出来的**（初版 0.3 能让 0.8 翻掉 0.9）。`confirmation_bias` **明确不接**（要"信念冲突度"，无数据源；别与亲密度平滑混淆） | ✅ 已上线 | [spec §3⑦](../openspec/specs/memory-system/spec.md) |
| ~~B3 fold-memory-llm-into-provider~~ ✅ | **2026-10-20 已做，默认关**（`let-memory-use-provider`，已归档）：`viaProvider` 开关 + 等价性测试（120s 必须带过去 / 错误语义翻译回契约 / `[LLM:memory]` 不丢）。★ **默认关的理由**：今天只有一个 provider ⇒ fallback 空转；走 provider 会多打一行 `[LLM]` 让 token 统计重复计数。**打开前提**：≥2 个 provider + 接受两行日志 | ✅ 能力就位（默认关） | [spec §4.1.4 契约 7.5](../openspec/specs/memory-system/spec.md) |
| ~~B4 memory-persona-link-v2~~ ✅ | **2026-10-20 查证后是"修 bug"而非"从零做"**（`fix-memory-knob-regression`，已归档）：`memory.*` 早就接进了 `applyToParam`/`regressIfStale`，但**共用的默认假设是错的** —— ① 24h 回归一律朝 **0**，而旋钮默认是 0.2/0.3/0.4 ⇒「`decay_rate→0`=永不遗忘、`importance_threshold→0`=什么都记」= **单向漂移**（改成分段回归，旋钮回各自默认）；② 通用 `clamp(-1,1)` 让 `decay_rate` 能变负（改为按值域：`retention_bias [-1,1]`，其余 `[0,1]`）。⚠️ 已知限制：只应用 `adjustments[0]` | ✅ 已上线 | [spec §4.3](../openspec/specs/memory-system/spec.md) |
| ~~B5 dsh-persona-single-source~~ ✅ | **2026-10-20 已定（用户拍板「维持两份，标清来源」）**（`label-dual-persona-sources`，已归档）：两份人格的关系写进 `persona.ts` 与 `soul.md` 顶部（源 / 浓缩 / 何时必须同步），并加**守卫测试** `tests/persona-sync.test.ts` —— 三条锚句按**概念**判据（身份/内在性/连续性），漏改会红；另断言浓缩 < 原文 1/3。★ 不合并的理由：dsh 每轮全量发 prefix，塞 13KB 等于白烧 token | ✅ 已上线 | [persona.ts](../packages/dsh-adapter/src/persona.ts) |
| ~~B6 clean-synthetic-facts~~ ✅ | **2026-10-20 查证：多半已不用做**。KI-20 的存量 **2026-10-17 已清**（`purge-synthetic-context-pollution`：180 条注入 + 1 条派生 fact），我先前的「116 条未清」是**旧信息**。本次交付改为：**只读复验工具** `scripts/synthetic-data-audit.cjs`（`readOnly`、`--backup` 仅文件复制含 `-wal`、已用最小库自测）+ 预案文档。判据：`facts.fromSynthetic == 0`，而 `events.synthetic` **非 0 是对的**（事件不删） | ✅ 工具就绪 | [PLAN](PLAN-2026-10-20-clean-synthetic-facts.md) |
| ~~tie-intimacy-to-speech~~ ✅ | **2026-10-20 已修并归档**：亲密度接上推送闸（四档 / 只降不升 / idle 只认真人 user 消息 / 迟滞 +5 / 他回来了只一次）。★ 顺带修掉**每日上限形同虚设**（计数复位挂在"摘要成功"上，失败时每 tick 清零，实测上限 3 发出 4 条） | ✅ 已上线 | [spec §11.1](../openspec/specs/ai-life-system/spec.md) |
| ~~let-her-decline-a-day~~ ✅ | **2026-10-20 已实现并归档**（用户拍板「可以拒绝」）：她可以这一轮不说话，但必须留理由（`internal` + `origin='decline'`，可被召回）。★ 关键判断：P1-6 防的是**生产故障**，不防**她的意愿** —— 拒绝路径照样续期锁。护栏：概率 0.15 / 连续上限 2 / 理由 ≥6 字 / **fail-open** | ✅ 已上线 | [spec §11.2](../openspec/specs/ai-life-system/spec.md) |
| retire-glm-vision-bridge | DeepSeek 原生可看图，GLM 那层技术上冗余（但记忆是纯文本的） | 🧑 决策 | [proposal](../openspec/changes/retire-glm-vision-bridge/proposal.md) |
| improve-sticker-selection | 表情包无权重/无冷却/无管理入口 | 🧑 先定三件事 | [proposal](../openspec/changes/improve-sticker-selection/proposal.md) |
| tune-recall-with-runtime-data | 召回系数是拍脑袋的，该由运行数据定 | ⏳ 先补观测 | [proposal](../openspec/changes/tune-recall-with-runtime-data/proposal.md) |
| add-ops-health-report | 缺**正确性**指标（摘要 22 天全灭时 healthcheck 全绿） | 🧑 原话"日报算了" | [proposal](../openspec/changes/add-ops-health-report/proposal.md) |
| console-a11y-motion | console 17 处持续动画无 `prefers-reduced-motion` | ⏸ 先记着 | [proposal](../openspec/changes/console-a11y-motion/proposal.md) |
| build-alysia-console-plugin | dsh 侧控制台插件：4 个面板页 + 真机验收 | 🤖 | [proposal](../openspec/changes/build-alysia-console-plugin/proposal.md) |
| add-approval-gate | 审批闸（2026-10-18 新开） | 🤖 | [proposal](../openspec/changes/add-approval-gate/proposal.md) |
| record-out-of-band-server-config-change | 记录一次带外服务器配置变更 | 🧑 | [proposal](../openspec/changes/record-out-of-band-server-config-change/proposal.md) |
| ~~阶段白名单没收她的产物~~ ✅ | **2026-10-18 已修**（`scope-loop-to-this-round`）：写权限分层（只有 `public/**` 是权限边界）+ 判据按本轮 `mtime` 过滤；`.tmp/` 不进快照 | ✅ 已上线 | [spec §17 契约 68b/68c](../openspec/specs/project-tasks/spec.md) |
| ~~build 类重阶段 30 分钟超时~~ ✅ | **2026-10-18 已修**（同一 change）：按阶段给超时（build 5400s）+ 超时杀进程组 | ✅ 已上线 | [spec §17 契约 68d](../openspec/specs/project-tasks/spec.md) |
| ~~她只能"新建"才能要地址~~ ✅ | **2026-10-19 已修**（`let-her-query-what-she-made`）：`list_my_pages` / `find_page` / `check_server_status` 三个只读工具 | ✅ 已上线 | [spec §17 契约 68h/68i](../openspec/specs/project-tasks/spec.md) |
| ~~没人盯着卡住的活~~ ✅ | **2026-10-19 已修**（`watch-for-stuck-work`）：`al:watchdog` 六条只读判据，**发现交给她、不推给用户** | ✅ 已上线 | [spec §17 契约 68j](../openspec/specs/project-tasks/spec.md) |
| ~~空查询撞 embed 400~~ ✅ | **2026-10-19 已修**（`fix-empty-embed-query`）：空 query 不请求 embedding | ✅ 已上线 | [spec §7](../openspec/specs/memory-system/spec.md) |
| 看门狗提醒的"硬度" | 现在把"提不提"完全交给她 —— 她收到提示也可能不提（真机验时她只寒暄了）。可选加一句"碍着你手上的活就说一句" | 🧑 一句话的事 | [change](../openspec/archive/2026-10-19-watch-for-stuck-work/tasks.md) |
| ~~结果回来没人接~~ ✅ | **2026-10-19 已修**（`wake-her-on-task-result`）：结果入 outbox → 唤起她跑完整一轮 → 她自己验收/返工/问人/汇报 | ✅ 已上线 | [spec §18](../openspec/specs/project-tasks/spec.md) |
| 唤醒派发的多实例租约 | 现在派发是**单实例进程内**的；开第二个 alysia 实例会两边同时领同一队列 | ⏳ 等多实例需求 | [spec §18 已知边界](../openspec/specs/project-tasks/spec.md) |

## D. 部署 / 数据债（代码已好，线上还是旧的）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| fix-reflection-insight-misroute | **已归档但未部署** ⇒ 线上每日反思仍会把 `insight` 错写进用户画像 | 🧑 发版会连带 console 改动 | [proposal](../openspec/archive/2026-10-15-fix-reflection-insight-misroute/proposal.md) |
| 历史画像回填 | 线上 `basics`/`facts` 长期稀疏，修复只保证从此往后 | 🧑 需连服务器 | [specs/index.md](../openspec/specs/index.md) |
| **镜像与线上漂移**（2026-10-19） | 本次是 `docker cp` 热替换 dist（备份 `/root/alysia/backups/dist-20261019-200542/`）；下次 `compose up -d` 重建会**退回镜像旧码** | 🧑 下次发版统一重打镜像 | [验收记录 §0](ACCEPTANCE-2026-10-19-WAKE.md) |
| **存量 31 条 `needs_review`**（2026-10-19） | 改前遗留：24 条卡在 `intent`（18 条结果 ≤80 字，基本是探针）；**不改**的理由：不阻塞任何链路、watchdog 不对 needs_review 报警、产物都在工作区 | 🧑 想清掉再说一声 | [验收记录 §4](ACCEPTANCE-2026-10-19-WAKE.md) |

## E. 暂停 / 不做

| 条目 | 一句话 | 决定 |
|---|---|---|
| 中途插话 / 暂停 | `continue_project_task` 在 `running` 时拒收意见，没有暂停接口 | ⏸ 2026-10-18 你明确"暂不设计" |
| webui-visual-redesign | 对象（Vue 版 `packages/webui`）已删 | 🗑 superseded，不再推进 |

## F. 已销账（**不在此重复正文**）

26 条 KI 中 **19 条已修**：KI-3 / 4 / 6 / 7 / 8 / 9 / 12 / 13 / 14 / 15 / 16 / 17 / 18 / 19 / 20 / 21 / 22 / 23 / 24
（其中 2026-10-20 新增 5 条：KI-3 / KI-7 / KI-8 / KI-9 / KI-18 —— 四个 change 已归档）。
证据与契约审计在 [KNOWN-ISSUES](KNOWN-ISSUES.md) 各自小节（带 ★ 与 change 链接）。
本表不列它们，只留这一行计数 —— **下次整理时核这个数字**：`26 - 19 = 7 条在办`
（KI-1 / 2 / 5 / 10 / 11 / 25 / 26，其中 KI-10 是「记着待观察」）。

---

## 维护提示

- 本表长度应**长期保持在 30 行量级**。超过 45 行说明在办的事太多了，不是在办的事太细。
- 每条被删掉时，在 commit message 里写清销账依据（`KI-xx → change xxx 已归档`），
  否则三个月后没人知道那行为什么消失。

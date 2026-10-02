# OpenSpec — Spec 索引

> 活的 spec 总索引。**新功能实现前先查这里**；任何变更先看对应 spec 是否已覆盖。
> 状态：`active` = 仍在演进，改动需走 change；`frozen` = 已实现且不演进，只读参考。
> 索引状态与 `openspec/archive/`、`openspec/changes/` 联动，每次 archive 必须更新本表。

| slug | 系统 | 状态 | 来源（旧文档） | 最后变更 |
|------|------|------|----------------|----------|
| memory-system | 记忆系统（7 store / 3 engine / 3 processor / 旋钮） | active | docs/superpowers/specs/2026-06-28-memory-system-design.md | 2026-10-02 **零行写入观测 §4.7 契约 3**（`observe-zero-row-writes`：`traceZeroRows` 只观测不拦截，采集 `changes===0` 分布，决策入口 `tune-zero-row-checks`）；**存储写入留痕契约 §4.7**（`fix-migration-and-logger-silent-failure`：迁移改探测式幂等、去掉 13 处裸 catch；日志子系统自身失败必须喊出来）；**推理预算观测契约 §4.1.2**（`add-llm-budget-observability`：provider 透出 `finish_reason`/`reasoning_tokens`，空响应单独可见，`role:'err'` 不再被压成空串）；10-01 **画像提取静默停摆修复**（采样槽契约 §4.1.1：max_tokens 共享预算 / json_object 按输出契约分类 / 第三参必须生效 / 禁裸 catch；4 个缺陷）；09-27 存量回填（52 条占位符摘要重生成 + 40 条垃圾向量替换 + 77 条缺失向量补齐；`getBySession` 加 `until`）；09-26 事件窗口截断修复；09-25 摘要静默失败修复与凭据外置；**09-25 召回管道三缺陷修复**（`optimize-recall-pipeline`：cosine 刻度退化 / `mergeWithQuota` 跨来源配额 / `RELATIVE_KEEP` 相对阈值去重）+ **`importance` 接线**（`wire-importance-signal`） |
| alysia-architecture | 总体架构（monorepo / 双模式） | active | docs/superpowers/specs/2026-07-20-alysia-architecture-design.md | 2026-10-02 **编程模式由 dsh 承接**（record-dsh-as-coding-mode，修正「砍掉编程模式」）；10-01 模块化装配（module-kernel：core 13 模块 + server 10 模块）；**09-25 砍掉 Electron 桌面端**（drop-electron-desktop）；08-15 WebUI 聊天端点 + LLM 流式契约 |
| pipeline-contract | Pipeline 契约 + 记忆修复 | frozen | docs/superpowers/specs/2026-07-30-pipeline-contract-and-memory-fix.md | 2026-08-07 迁移 |
| server-desktop-separation | 服务端/桌面端分离 | frozen | docs/superpowers/specs/2026-07-30-server-desktop-separation.md | 2026-08-07 迁移 |
| server-optimization | 服务端优化（流式/stop/WebUI 待做项） | frozen | docs/superpowers/specs/2026-07-30-server-optimization.md | 2026-08-07 迁移 |
| knowledge-base-import | 知识库导入 | frozen | docs/superpowers/specs/2026-07-31-knowledge-base-import.md | 2026-08-07 迁移 |
| role-system | v3 角色系统（import/export/active） | active | docs/superpowers/specs/2026-07-31-role-system.md | 2026-10-01 **修复 importRole 清空人设**（改按字段合并；表情包角色包曾每次启动冲掉昔涟的 system_prompt，change: fix-role-import-wipes-persona）；08-07 迁移 |
| domestic-search-weather | 国内搜索 + 天气 | frozen | docs/superpowers/specs/2026-08-02-domestic-search-weather.md | 2026-08-07 迁移 |
| logging-system | 日志系统（本地时间/文件持久化） | frozen | docs/superpowers/specs/2026-08-02-logging-system.md | 2026-08-07 迁移 |
| proactive-messages | 主动消息（时段问候/节日/关怀） | active | docs/superpowers/specs/2026-08-02-proactive-messages.md | 2026-08-09 回写+对话上下文（记忆闭环） |
| profile-fact-sourcing | 画像事实溯源 | frozen | docs/superpowers/specs/2026-08-02-profile-fact-sourcing.md | 2026-08-07 迁移 |
| qq-reconnect-backoff | QQ 重连退避 | frozen | docs/superpowers/specs/2026-08-02-qq-reconnect-backoff.md | 2026-08-07 迁移 |
| role-memory-isolation | 角色记忆隔离 | 搁置 | docs/superpowers/specs/2026-08-02-role-memory-isolation.md | 2026-08-07 迁移 |
| server-hardening | 服务端加固 | active | docs/superpowers/specs/2026-08-02-server-hardening.md | 2026-09-25 鉴权触发条件改为跟随绑定地址（`server-bind-host`，回环免鉴权）+ 9-24 钩子范围修复（只守 /api/*） |
| sticker-protocol | 表情包协议 | frozen | docs/superpowers/specs/2026-08-02-sticker-protocol.md | 2026-08-07 迁移 |
| tool-call-text-strip | 工具调用文本剥离 | frozen | docs/superpowers/specs/2026-08-02-tool-call-text-strip.md | 2026-08-07 迁移 |
| ai-life-system | AI 主动生活系统（LifeService） | active | docs/superpowers/specs/2026-08-06-ai-life-system-design.md | 2026-10-02 **事件生成链路日志契约**（`add-llm-budget-observability`：槽位级 `finish/tokens/reasoning/content` 现场 + 调用失败不再伪装成"模型没输出"）；10-01 提示词资产搬到 `packages/server/src/prompts/`（externalize-life-prompts，含「为何不做 .md」判据 + 7 条守卫）；08-31 每日反思闭环（L3 自修改执行器） |
| vision-bridge | 图片识别（GLM-4V-Flash 描述） | frozen | （无旧文档，2026-08-07 补） | 2026-08-07 新建 |
| webui-system | WebUI 前端（Vue SPA/主题/管理面板/聊天视图） | active（**待废弃**） | （无旧文档，2026-08-15 补） | 2026-09-25 `console-local-serve` 后静态托管改为可切换 + `drop-electron-desktop` 删掉 `/desktop` 与 Electron 壳 + `migrate-live2d-to-console` 迁出 Live2D；⚠️ 2026-09-24 起由 `alysia-console` 取代，**整体删除尚未开 change**（有三个真实耦合点：`server.ts` 的 `defaultDist`、`bootstrap.ts` 的 `IS_DESKTOP` 分支、webui 侧 Live2D/模型残留）。`webui-visual-redesign`（8-15 布局大改）**已被取代、不再推进** |
| reminder-tool | 提醒工具（set/list/cancel + 推送） | active | （无旧文档，2026-08-07 补） | 2026-08-12 SQLite 持久化（重启恢复，过期补发） |
| dsh-adapter | DSH 插件适配层（昔涟人格/记忆接入 DeepSeek Harness） | active | （无旧文档，2026-08-25 补） | 2026-10-01 bundle 化（`dsh.bundle.patch` + preset 声明，人设改走 `{{alysia_persona}}` 变量可切换；preset 派生自 standard 以保住工具集）+ **双进程通道落地**（`POST /api/ingest` / `GET /api/persona/prompt`，change: connect-dsh-alysia-bridge）；10-02 **读通道补齐**（`POST /api/memory/read` + 插件缓存/预热 + recall_memory 真工具，change: bridge-memory-read）；10-01 bundle 化 + 写通道；08-25 MVP 验证闭环 |
| alysia-console | 昔涟控制台 · Next.js 新前端（设计系统/API 层/适配层/部署形态） | active | （无旧文档，2026-09-24 建） | 2026-09-25 集中落地：`adopt-nextjs-console`（收编 + 真数据）、`console-local-serve`（服务端同源托管 + 回环免 token）、`deploy-console-remote`（远端 Docker 部署已上线）、`wire-console-chat`（真会话 + 流式对话 `/api/chat/stream`）、`add-life-readonly-endpoints`（`/api/life/summaries` + `/companions`）、`migrate-live2d-to-console` + `live2d-persist-across-pages`（Live2D 迁入 + 跨页持久化，贴图 8192²→2048²）、`server-bind-host`（鉴权边界）、`drop-electron-desktop`（删 `/desktop`） |
| module-kernel | 模块内核（Module 契约 / ModuleHost / 拓扑排序与逆序卸载） | active | （无旧文档，2026-10-01 建） | 2026-10-01：新建（add-module-kernel）→ 删掉依据错误的 `peer` 机制（drop-kernel-peer）→ **接入 `AlysiaCore.start()`**（modularize-core-assembly，13 个模块，公开面不变）。契约刻意做成 cordis 形状，为 dsh 迁移铺路；10-01 模块级单测 28 用例（add-module-tests）；**server 侧 bootstrap 拆成 10 个模块**（modularize-server-assembly，抽出 PushChannel） |

## 📌 Backlog（doc 已声明、impl 未接，记录在案不隐形）

| change | 说明 | 方向 |
|--------|------|------|
| [worldbook-sampling-cooldown](../changes/worldbook-sampling-cooldown/proposal.md) | ai-life §6/7 世界书采样缺 cooldown 过滤（只做了 priority 排序 + hit_count） | docs → impl（补实现，spec 不改） |
| [add-platforms-endpoint](../changes/add-platforms-endpoint/proposal.md) | Web-API §3.4 `GET /api/platforms` 全仓库无实现——唯一文档了但完全没建的接口 | docs → impl（补实现，契约不改） |
| [console-a11y-motion](../changes/console-a11y-motion/proposal.md) | console 17 处持续动画无 `prefers-reduced-motion` 守卫；hero 渐变标题在 `forced-colors` 下可能不可见 | 新增（非 doc/impl gap，9-24 核查发现）；用户指示「先记下来」暂不实现 |
| [tune-recall-with-runtime-data](../changes/tune-recall-with-runtime-data/proposal.md) | 召回管道的系数（`LIFE_BASE`/`RELATIVE_KEEP`/情绪词表…）全是启发式拍的，该由运行数据定；**且部分指标现在无日志，要先补观测** | 新增；用户 9-25「运行一段时间上服务器捞数据看看」 |
| [add-ops-health-report](../changes/add-ops-health-report/proposal.md) | 会话摘要 **22 天 100% 失败**期间，容器 healthcheck 与 `/api/health` **全程为绿**——缺的是正确性指标（摘要成功率/各模块 WARN 计数），不是存活指标 | 新增（可观测性）；**用户 9-25 决定先记档后做**；前置：日志系统先整理（96.6% 是 QQ 噪声） |
| [clean-spec-diff-residue](../changes/clean-spec-diff-residue/proposal.md) | apply 未去 diff 标记的产物残留。★ **2026-10-02 复核：范围比立项时记的大** —— `memory-system/spec.md` 5 行（`persona-overlay-perspective`）、`ai-life-system/spec.md` **约 42 行**（`worldbook-digest-summary` / `life-interval-narrative` / `chat-life-continuity` / `mood-side-analysis` / `worldview-crossworld-window` / `life-event-message-split` / `worldview-base-field` 等多次 apply 层层累积）、`alysia-console/spec.md` 1 行 | 文档卫生；⚠️ **不能用 `grep '^\+'` 直接删** —— 得逐条判「是 diff 残留还是正文」：`ai-life-system` 里混着 ASCII 树角字符 `+│` 与提示词模板正文 |
| [tune-zero-row-checks](../changes/tune-zero-row-checks/proposal.md) | **KI-11 的决策入口**：全 core 55 个写入点只有 3 处检查 `.run().changes` —— 「改到了」与「什么都没改」同形（`markDelivered` 会影响重复推送、`PersonaStore` 8 个 `WHERE is_active=1` 会报假成功）。**观测已上线**（`observe-zero-row-writes` 打 `[WriteTrace]`），**等运行数据再逐点定性**：豁免 / 硬校验 | 新增；**用户 2026-10-02「先打日志，后续运行一段时间后检查再决策」** |
| [fix-store-write-trace](../changes/fix-store-write-trace/proposal.md) | **存储可观测性第二刀**：KI-12（`INSERT OR REPLACE` 列单缺 `archived` → 重投静默复活软删会话）/ KI-13（知识库半截文档 + hash 去重锁死）/ KI-14（`LanceDBStore.insert` 永不抛 → 上游 catch 成死代码，**2026-09-27 事故同形代码仍活着**）/ KI-15（`vectorStore` null 静默跳过 10 条路径）/ KI-16（`PersonaStore` 读时回写默认值）/ KI-17 + KI-5 剩余 9 处裸 catch | 新增；第一刀只修"地基"，本刀要**改判断语义**，各自需独立验证 |
| [decide-life-event-max-tokens](../changes/decide-life-event-max-tokens/proposal.md) | **KI-1 的数据决策**：`life.generateEvent` 无 `max_tokens`，与已爆三次的槽同形。观测已上线（provider `[LLM]` 行 + `[Life] event LLM` 行），**等数据再定**；顺带闭环 KI-2（`proactive.personalize` / `vision.describe`） | 新增；**纪律：没有观测就不许改预算数字**；数据显示安全也得在 §4.1.2 记一句闭环 |
| [remove-packages-webui](../changes/remove-packages-webui/proposal.md) | `packages/webui` **三个删除约束全解除但删除从未执行**（`IS_DESKTOP` 分流 / `defaultDist` 回落 / Live2D 残留）。**这个 change 此前从未建立过**——2026-10-02 整理时发现的真实缺口 | 新增；⚠️ **不是纯删**，删前先确认 5 个耦合点 |
| [unify-core-shutdown](../changes/unify-core-shutdown/proposal.md) | **KI-6**：`core.stop()` 不关 SQLite / LanceDB 句柄 → Windows 上临时目录删不掉（EPERM）。行为变更，需单独验证 | 已定名未开 change（`modularize-core-assembly` proposal 决策 2 预留）；2026-10-02 补登记 |

> 📦 **已销账**（2026-10-02 整理）：`backfill-failed-session-summaries` 已于 **2026-09-27 归档**
> （`openspec/archive/2026-09-27-backfill-failed-session-summaries/`），本表原有的一行已移除
> ——它此前是**死链**（`changes/` 下已无该目录）。
> 🗑️ `webui-visual-redesign` 属**已被取代**（非 backlog）：其对象是 Vue 版 webui 的布局大改，
> 而 webui 本身待废、由 `alysia-console` 接管；8-15 起的「方案待确认」就挂在那里、不再推进，
> 且代码里查无其实施落点。**不再推进**，随 `remove-packages-webui` 一起收尾。
>
> 📋 **仍在 `docs/KNOWN-ISSUES.md` 登记、尚未开 change 的缺陷**（该册是 triage 入口，修一条 = 开一个 change）：
> **KI-3**（两个 `ILLMService` 实现无一致性契约测试）、**KI-4**（`PersonaAdapter` 裸 `JSON.parse`）、
> **KI-7**（`/stop` 只打日志不中断）、**KI-8**（根目录 `config.yml` 是死文件）、
> **KI-9**（`memory/services/` 疑似半死代码）、**KI-10**（内核缺「只排序不依赖服务」的表达方式）、
> 以及**历史画像回填**（线上 `basics`/`facts` 长期稀疏，修复只保证从此往后）。
> —— **已开 change 的那几条**（KI-1 / KI-5 部分 / KI-6 / KI-11～KI-17）在上表有行，点进去即可。

## 相关活文档（非 spec，但同为 source of truth）

| 文档 | 说明 |
|------|------|
| docs/Web-API-Design.md | Web 端 API 契约（★ 开发约束：新增/修改 core 方法必须先对照） |
| docs/Docker-Deployment.md | 服务端版本更新 SOP（部署流程） |
| docs/README.md | 全文档总索引（本文件为 spec 索引，README 为所有文档入口） |
| openspec/archive/ | 归档：已完成 change + 旧 spec 版本 + legacy 迁移文档 |
| openspec/changes/ | 进行中/挂起的 change |

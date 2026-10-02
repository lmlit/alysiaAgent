# OpenSpec — Spec 索引

> 活的 spec 总索引。**新功能实现前先查这里**；任何变更先看对应 spec 是否已覆盖。
> 状态：`active` = 仍在演进，改动需走 change；`frozen` = 已实现且不演进，只读参考。
> 索引状态与 `openspec/archive/`、`openspec/changes/` 联动，每次 archive 必须更新本表。

| slug | 系统 | 状态 | 来源（旧文档） | 最后变更 |
|------|------|------|----------------|----------|
| memory-system | 记忆系统（7 store / 3 engine / 3 processor / 旋钮） | active | docs/superpowers/specs/2026-06-28-memory-system-design.md | 2026-10-01 **画像提取静默停摆修复**（采样槽契约 §4.1.1：max_tokens 共享预算 / json_object 按输出契约分类 / 第三参必须生效 / 禁裸 catch；4 个缺陷）；09-27 存量回填（52 条占位符摘要重生成 + 40 条垃圾向量替换 + 77 条缺失向量补齐；`getBySession` 加 `until`）；09-26 事件窗口截断修复；09-25 摘要静默失败修复与凭据外置 |
| alysia-architecture | 总体架构（monorepo / 双模式） | active | docs/superpowers/specs/2026-07-20-alysia-architecture-design.md 2026-10-02 **编程模式由 dsh 承接**（record-dsh-as-coding-mode，修正「砍掉编程模式」）；10-01 模块化装配（module-kernel）；08-15 WebUI 聊天端点 + LLM 流式契约 |
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
| server-hardening | 服务端加固 | active | docs/superpowers/specs/2026-08-02-server-hardening.md | 2026-09-25 鉴权触发条件改为跟随绑定地址（回环免鉴权）+ 9-24 钩子范围修复（只守 /api/*） |
| sticker-protocol | 表情包协议 | frozen | docs/superpowers/specs/2026-08-02-sticker-protocol.md | 2026-08-07 迁移 |
| tool-call-text-strip | 工具调用文本剥离 | frozen | docs/superpowers/specs/2026-08-02-tool-call-text-strip.md | 2026-08-07 迁移 |
| ai-life-system | AI 主动生活系统（LifeService） | active | docs/superpowers/specs/2026-08-06-ai-life-system-design.md | 2026-10-01 提示词资产搬到 `packages/server/src/prompts/`（externalize-life-prompts，含「为何不做 .md」判据 + 7 条守卫）；08-31 每日反思闭环（L3 自修改执行器） |
| vision-bridge | 图片识别（GLM-4V-Flash 描述） | frozen | （无旧文档，2026-08-07 补） | 2026-08-07 新建 |
| webui-system | WebUI 前端（Vue SPA/主题/管理面板/聊天视图） | active（**待废弃**） | （无旧文档，2026-08-15 补） | 2026-08-15 一期完成（M1-M3 前端 + M4 Electron 壳 + Live2D 桌宠）；⚠️ 2026-09-24 起由 `alysia-console` 取代，废弃需先安置 Live2D 资产/Electron 壳/pet.html |
| reminder-tool | 提醒工具（set/list/cancel + 推送） | active | （无旧文档，2026-08-07 补） | 2026-08-12 SQLite 持久化（重启恢复，过期补发） |
| dsh-adapter | DSH 插件适配层（昔涟人格/记忆接入 DeepSeek Harness） | active | （无旧文档，2026-08-25 补） | 2026-10-01 bundle 化（`dsh.bundle.patch` + preset 声明，人设改走 `{{alysia_persona}}` 变量可切换；preset 派生自 standard 以保住工具集）+ **双进程通道落地**（`POST /api/ingest` / `GET /api/persona/prompt`，change: connect-dsh-alysia-bridge）；10-02 **读通道补齐**（`POST /api/memory/read` + 插件缓存/预热 + recall_memory 真工具，change: bridge-memory-read）；10-01 bundle 化 + 写通道；08-25 MVP 验证闭环 |
| alysia-console | 昔涟控制台 · Next.js 新前端（设计系统/API 层/适配层/部署形态） | active | （无旧文档，2026-09-24 建） | 2026-09-25 本地回环绑定（免 token）；09-24 收编 + 接只读真数据 + 本地部署形态 + 鉴权边界修复 |
| module-kernel | 模块内核（Module 契约 / ModuleHost / 拓扑排序与逆序卸载） | active | （无旧文档，2026-10-01 建） | 2026-10-01：新建（add-module-kernel）→ 删掉依据错误的 `peer` 机制（drop-kernel-peer）→ **接入 `AlysiaCore.start()`**（modularize-core-assembly，13 个模块，公开面不变）。契约刻意做成 cordis 形状，为 dsh 迁移铺路；10-01 模块级单测 28 用例（add-module-tests）；**server 侧 bootstrap 拆成 10 个模块**（modularize-server-assembly，抽出 PushChannel） |

## 📌 Backlog（doc 已声明、impl 未接，记录在案不隐形）

| change | 说明 | 方向 |
|--------|------|------|
| [worldbook-sampling-cooldown](../changes/worldbook-sampling-cooldown/proposal.md) | ai-life §6/7 世界书采样缺 cooldown 过滤（只做了 priority 排序 + hit_count） | docs → impl（补实现，spec 不改） |
| [add-platforms-endpoint](../changes/add-platforms-endpoint/proposal.md) | Web-API §3.4 `GET /api/platforms` 全仓库无实现——唯一文档了但完全没建的接口 | docs → impl（补实现，契约不改） |
| [console-a11y-motion](../changes/console-a11y-motion/proposal.md) | console 17 处持续动画无 `prefers-reduced-motion` 守卫；hero 渐变标题在 `forced-colors` 下可能不可见 | 新增（非 doc/impl gap，9-24 核查发现）；用户指示「先记下来」暂不实现 |
| [tune-recall-with-runtime-data](../changes/tune-recall-with-runtime-data/proposal.md) | 召回管道的系数（`LIFE_BASE`/`RELATIVE_KEEP`/情绪词表…）全是启发式拍的，该由运行数据定；**且部分指标现在无日志，要先补观测** | 新增；用户 9-25「运行一段时间上服务器捞数据看看」 |
| [backfill-failed-session-summaries](../changes/backfill-failed-session-summaries/proposal.md) | 线上 **52 条会话摘要是占位符** + 52 条近乎相同的垃圾向量污染 LanceDB（可能被召回）。**依赖 `fix-session-summary-silent-failure` 先落地** | 存量数据修复；先确认 events 可回填性 + 生产库写入授权 |
| [add-ops-health-report](../changes/add-ops-health-report/proposal.md) | 会话摘要 **22 天 100% 失败**期间，容器 healthcheck 与 `/api/health` **全程为绿**——缺的是正确性指标（摘要成功率/各模块 WARN 计数），不是存活指标 | 新增（可观测性）；**用户 9-25 决定先记档后做**；前置：日志系统先整理（96.6% 是 QQ 噪声） |
| [clean-spec-diff-residue](../changes/clean-spec-diff-residue/proposal.md) | `openspec/specs/memory-system/spec.md` **残留 5 行未清理的 `+ ` diff 标记**（`persona-overlay-perspective` 的 apply 未去标记）——今天已两次导致校验工具给出错误结论 | 文档卫生；apply 流程产物未清 |

## 相关活文档（非 spec，但同为 source of truth）

| 文档 | 说明 |
|------|------|
| docs/Web-API-Design.md | Web 端 API 契约（★ 开发约束：新增/修改 core 方法必须先对照） |
| docs/Docker-Deployment.md | 服务端版本更新 SOP（部署流程） |
| docs/README.md | 全文档总索引（本文件为 spec 索引，README 为所有文档入口） |
| openspec/archive/ | 归档：已完成 change + 旧 spec 版本 + legacy 迁移文档 |
| openspec/changes/ | 进行中/挂起的 change |

# OpenSpec — Spec 索引

> 活的 spec 总索引。**新功能实现前先查这里**；任何变更先看对应 spec 是否已覆盖。
> 状态：`active` = 仍在演进，改动需走 change；`frozen` = 已实现且不演进，只读参考。
> 索引状态与 `openspec/archive/`、`openspec/changes/` 联动，每次 archive 必须更新本表。

| slug | 系统 | 状态 | 来源（旧文档） | 最后变更 |
|------|------|------|----------------|----------|
| memory-system | 记忆系统（7 store / 3 engine / 3 processor / 旋钮） | active | docs/superpowers/specs/2026-06-28-memory-system-design.md | 2026-08-29 CR 修复：会话隔离精确匹配/删除清向量/空 catch 补日志 |
| alysia-architecture | 总体架构（monorepo / 双模式） | active | docs/superpowers/specs/2026-07-20-alysia-architecture-design.md | 2026-08-15 WebUI 聊天端点（on_chunk/on_done + prompt/stream/messages/pending）+ LLM 流式契约 |
| pipeline-contract | Pipeline 契约 + 记忆修复 | frozen | docs/superpowers/specs/2026-07-30-pipeline-contract-and-memory-fix.md | 2026-08-07 迁移 |
| server-desktop-separation | 服务端/桌面端分离 | frozen | docs/superpowers/specs/2026-07-30-server-desktop-separation.md | 2026-08-07 迁移 |
| server-optimization | 服务端优化（流式/stop/WebUI 待做项） | frozen | docs/superpowers/specs/2026-07-30-server-optimization.md | 2026-08-07 迁移 |
| knowledge-base-import | 知识库导入 | frozen | docs/superpowers/specs/2026-07-31-knowledge-base-import.md | 2026-08-07 迁移 |
| role-system | v3 角色系统（import/export/active） | active | docs/superpowers/specs/2026-07-31-role-system.md | 2026-08-07 迁移 |
| domestic-search-weather | 国内搜索 + 天气 | frozen | docs/superpowers/specs/2026-08-02-domestic-search-weather.md | 2026-08-07 迁移 |
| logging-system | 日志系统（本地时间/文件持久化） | frozen | docs/superpowers/specs/2026-08-02-logging-system.md | 2026-08-07 迁移 |
| proactive-messages | 主动消息（时段问候/节日/关怀） | active | docs/superpowers/specs/2026-08-02-proactive-messages.md | 2026-08-09 回写+对话上下文（记忆闭环） |
| profile-fact-sourcing | 画像事实溯源 | frozen | docs/superpowers/specs/2026-08-02-profile-fact-sourcing.md | 2026-08-07 迁移 |
| qq-reconnect-backoff | QQ 重连退避 | frozen | docs/superpowers/specs/2026-08-02-qq-reconnect-backoff.md | 2026-08-07 迁移 |
| role-memory-isolation | 角色记忆隔离 | 搁置 | docs/superpowers/specs/2026-08-02-role-memory-isolation.md | 2026-08-07 迁移 |
| server-hardening | 服务端加固 | active | docs/superpowers/specs/2026-08-02-server-hardening.md | 2026-09-25 鉴权触发条件改为跟随绑定地址（回环免鉴权）+ 9-24 钩子范围修复（只守 /api/*） |
| sticker-protocol | 表情包协议 | frozen | docs/superpowers/specs/2026-08-02-sticker-protocol.md | 2026-08-07 迁移 |
| tool-call-text-strip | 工具调用文本剥离 | frozen | docs/superpowers/specs/2026-08-02-tool-call-text-strip.md | 2026-08-07 迁移 |
| ai-life-system | AI 主动生活系统（LifeService） | active | docs/superpowers/specs/2026-08-06-ai-life-system-design.md | 2026-08-31 每日反思闭环（L3 自修改执行器） |
| vision-bridge | 图片识别（GLM-4V-Flash 描述） | frozen | （无旧文档，2026-08-07 补） | 2026-08-07 新建 |
| webui-system | WebUI 前端（Vue SPA/主题/管理面板/聊天视图） | active（**待废弃**） | （无旧文档，2026-08-15 补） | 2026-08-15 一期完成（M1-M3 前端 + M4 Electron 壳 + Live2D 桌宠）；⚠️ 2026-09-24 起由 `alysia-console` 取代，废弃需先安置 Live2D 资产/Electron 壳/pet.html |
| reminder-tool | 提醒工具（set/list/cancel + 推送） | active | （无旧文档，2026-08-07 补） | 2026-08-12 SQLite 持久化（重启恢复，过期补发） |
| dsh-adapter | DSH 插件适配层（昔涟人格/记忆接入 DeepSeek Harness） | active | （无旧文档，2026-08-25 补） | 2026-08-25 MVP 验证闭环（插件生命周期/工具链路/roster 挂载，数据层二期） |
| alysia-console | 昔涟控制台 · Next.js 新前端（设计系统/API 层/适配层/部署形态） | active | （无旧文档，2026-09-24 建） | 2026-09-25 本地回环绑定（免 token）；09-24 收编 + 接只读真数据 + 本地部署形态 + 鉴权边界修复 |

## 📌 Backlog（doc 已声明、impl 未接，记录在案不隐形）

| change | 说明 | 方向 |
|--------|------|------|
| [worldbook-sampling-cooldown](../changes/worldbook-sampling-cooldown/proposal.md) | ai-life §6/7 世界书采样缺 cooldown 过滤（只做了 priority 排序 + hit_count） | docs → impl（补实现，spec 不改） |
| [add-platforms-endpoint](../changes/add-platforms-endpoint/proposal.md) | Web-API §3.4 `GET /api/platforms` 全仓库无实现——唯一文档了但完全没建的接口 | docs → impl（补实现，契约不改） |
| [console-a11y-motion](../changes/console-a11y-motion/proposal.md) | console 17 处持续动画无 `prefers-reduced-motion` 守卫；hero 渐变标题在 `forced-colors` 下可能不可见 | 新增（非 doc/impl gap，9-24 核查发现）；用户指示「先记下来」暂不实现 |
| [tune-recall-with-runtime-data](../changes/tune-recall-with-runtime-data/proposal.md) | 召回管道的系数（`LIFE_BASE`/`RELATIVE_KEEP`/情绪词表…）全是启发式拍的，该由运行数据定；**且部分指标现在无日志，要先补观测** | 新增；用户 9-25「运行一段时间上服务器捞数据看看」 |

## 相关活文档（非 spec，但同为 source of truth）

| 文档 | 说明 |
|------|------|
| docs/Web-API-Design.md | Web 端 API 契约（★ 开发约束：新增/修改 core 方法必须先对照） |
| docs/Docker-Deployment.md | 服务端版本更新 SOP（部署流程） |
| docs/README.md | 全文档总索引（本文件为 spec 索引，README 为所有文档入口） |
| openspec/archive/ | 归档：已完成 change + 旧 spec 版本 + legacy 迁移文档 |
| openspec/changes/ | 进行中/挂起的 change |

# OpenSpec — Spec 索引

> 活的 spec 总索引。**新功能实现前先查这里**；任何变更先看对应 spec 是否已覆盖。
> 状态：`active` = 仍在演进，改动需走 change；`frozen` = 已实现且不演进，只读参考。
> 索引状态与 `openspec/archive/`、`openspec/changes/` 联动，每次 archive 必须更新本表。

| slug | 系统 | 状态 | 来源（旧文档） | 最后变更 |
|------|------|------|----------------|----------|
| memory-system | 记忆系统（7 store / 3 engine / 3 processor / 旋钮） | active | docs/superpowers/specs/2026-06-28-memory-system-design.md | 2026-08-09 记忆完整性三件套（回写/定期归档/事件检索） |
| alysia-architecture | 总体架构（monorepo / 双模式） | active | docs/superpowers/specs/2026-07-20-alysia-architecture-design.md | 2026-08-07 迁移 |
| pipeline-contract | Pipeline 契约 + 记忆修复 | frozen | docs/superpowers/specs/2026-07-30-pipeline-contract-and-memory-fix.md | 2026-08-07 迁移 |
| server-desktop-separation | 服务端/桌面端分离 | frozen | docs/superpowers/specs/2026-07-30-server-desktop-separation.md | 2026-08-07 迁移 |
| server-optimization | 服务端优化（流式/stop/WebUI 待做项） | frozen | docs/superpowers/specs/2026-07-30-server-optimization.md | 2026-08-07 迁移 |
| knowledge-base-import | 知识库导入 | frozen | docs/superpowers/specs/2026-07-31-knowledge-base-import.md | 2026-08-07 迁移 |
| role-system | v3 角色系统（import/export/active） | active | docs/superpowers/specs/2026-07-31-role-system.md | 2026-08-07 迁移 |
| domestic-search-weather | 国内搜索 + 天气 | frozen | docs/superpowers/specs/2026-08-02-domestic-search-weather.md | 2026-08-07 迁移 |
| logging-system | 日志系统（本地时间/文件持久化） | frozen | docs/superpowers/specs/2026-08-02-logging-system.md | 2026-08-07 迁移 |
| proactive-messages | 主动消息（时段问候/节日/关怀） | active | docs/superpowers/specs/2026-08-02-proactive-messages.md | 2026-08-08 care-polish（关怀个性化/素材修正） |
| profile-fact-sourcing | 画像事实溯源 | frozen | docs/superpowers/specs/2026-08-02-profile-fact-sourcing.md | 2026-08-07 迁移 |
| qq-reconnect-backoff | QQ 重连退避 | frozen | docs/superpowers/specs/2026-08-02-qq-reconnect-backoff.md | 2026-08-07 迁移 |
| role-memory-isolation | 角色记忆隔离 | 搁置 | docs/superpowers/specs/2026-08-02-role-memory-isolation.md | 2026-08-07 迁移 |
| server-hardening | 服务端加固 | active | docs/superpowers/specs/2026-08-02-server-hardening.md | 2026-08-08 owner-id 凭据化/healthcheck IPv4 |
| sticker-protocol | 表情包协议 | frozen | docs/superpowers/specs/2026-08-02-sticker-protocol.md | 2026-08-07 迁移 |
| tool-call-text-strip | 工具调用文本剥离 | frozen | docs/superpowers/specs/2026-08-02-tool-call-text-strip.md | 2026-08-07 迁移 |
| ai-life-system | AI 主动生活系统（LifeService） | active | docs/superpowers/specs/2026-08-06-ai-life-system-design.md | 2026-08-09 事件驱动调度 + 延续机制 + 分段推送 |
| vision-bridge | 图片识别（GLM-4V-Flash 描述） | frozen | （无旧文档，2026-08-07 补） | 2026-08-07 新建 |
| reminder-tool | 提醒工具（set/list/cancel + 推送） | active | （无旧文档，2026-08-07 补） | 2026-08-08 reliability（超长拒绝/失败重试） |

## 📌 Backlog（doc 已声明、impl 未接，记录在案不隐形）

| change | 说明 | 方向 |
|--------|------|------|
| [worldbook-sampling-cooldown](../changes/worldbook-sampling-cooldown/proposal.md) | ai-life §6/7 世界书采样缺 cooldown 过滤（只做了 priority 排序 + hit_count） | docs → impl（补实现，spec 不改） |
| [add-platforms-endpoint](../changes/add-platforms-endpoint/proposal.md) | Web-API §3.4 `GET /api/platforms` 全仓库无实现——唯一文档了但完全没建的接口 | docs → impl（补实现，契约不改） |
| [memory-knobs-into-recall-pipeline](../changes/memory-knobs-into-recall-pipeline/proposal.md) | memory §4.3 旋钮只接亲密度，召回/遗忘管道零消费（半空转） | docs → impl（补实现，spec 不改） |

## 相关活文档（非 spec，但同为 source of truth）

| 文档 | 说明 |
|------|------|
| docs/Web-API-Design.md | Web 端 API 契约（★ 开发约束：新增/修改 core 方法必须先对照） |
| docs/Docker-Deployment.md | 服务端版本更新 SOP（部署流程） |
| docs/README.md | 全文档总索引（本文件为 spec 索引，README 为所有文档入口） |
| openspec/archive/ | 归档：已完成 change + 旧 spec 版本 + legacy 迁移文档 |
| openspec/changes/ | 进行中/挂起的 change |

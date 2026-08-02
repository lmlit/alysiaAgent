# Alysia Agent — 文档索引

> 通过本索引可检索当前项目的**所有设计思路与状态**。实现时遵循"先 spec 后实现"，每个已实现系统都有对应设计文档。

## 📚 Specs（设计文档）

| 日期 | 文档 | 主题 | 状态 |
|------|------|------|------|
| 2026-06-28 | [memory-system-design](superpowers/specs/2026-06-28-memory-system-design.md) | 记忆系统（7 Store/3 Engine/3 Processor） | ✅ 已实现 |
| 2026-07-20 | [alysia-architecture-design](superpowers/specs/2026-07-20-alysia-architecture-design.md) | 总体架构（Pipeline 洋葱模型/EventBus） | ✅ 已实现 |
| 2026-07-30 | [server-desktop-separation](superpowers/specs/2026-07-30-server-desktop-separation.md) | 服务端/桌面端分离（Feature Flags） | ✅ 已实现 |
| 2026-07-30 | [server-optimization](superpowers/specs/2026-07-30-server-optimization.md) | 服务端优化项 | ✅ 已实现 |
| 2026-07-30 | [pipeline-contract-and-memory-fix](superpowers/specs/2026-07-30-pipeline-contract-and-memory-fix.md) | Pipeline 契约 + 记忆链路修复 | ✅ 已实现 |
| 2026-07-31 | [knowledge-base-import](superpowers/specs/2026-07-31-knowledge-base-import.md) | 知识库导入 | ✅ 已实现 |
| 2026-07-31 | [role-system](superpowers/specs/2026-07-31-role-system.md) | 角色系统（角色包/世界书/素材） | ✅ 已实现 |
| 2026-08-02 | [sticker-protocol](superpowers/specs/2026-08-02-sticker-protocol.md) | 表情包协议（文案标记/私聊发送/群聊限制） | ✅ 已实现 |
| 2026-08-02 | [proactive-messages](superpowers/specs/2026-08-02-proactive-messages.md) | 主动消息（问候/节日/节气/关怀/提醒推送） | ✅ 已实现 |
| 2026-08-02 | [domestic-search-weather](superpowers/specs/2026-08-02-domestic-search-weather.md) | 搜索/天气国内适配（cn.bing/weather.com.cn） | ✅ 已实现 |
| 2026-08-02 | [logging-system](superpowers/specs/2026-08-02-logging-system.md) | 日志系统（统一 logger/节点清单/格式） | ✅ 已实现 |
| 2026-08-02 | [role-memory-isolation](superpowers/specs/2026-08-02-role-memory-isolation.md) | 角色记忆隔离（per-role 画像/会话） | ⏸ 搁置（思路留存） |
| 2026-08-02 | [tool-call-text-strip](superpowers/specs/2026-08-02-tool-call-text-strip.md) | 工具调用残留文本剥离（防伪 XML 泄漏给用户） | ✅ 已实现 |
| 2026-08-02 | [profile-fact-sourcing](superpowers/specs/2026-08-02-profile-fact-sourcing.md) | 画像事实来源标记（directly_stated → "[你说过]"）+ 上下文注入现状 | ✅ 已实现 |
| 2026-08-02 | [qq-reconnect-backoff](superpowers/specs/2026-08-02-qq-reconnect-backoff.md) | QQ 断线自动重连（指数退避，网络恢复自动上线） | ✅ 已实现 |

## 📋 Plans（实施计划）

- 2026-06-28 [memory-system-plan](superpowers/plans/2026-06-28-memory-system-plan.md)
- 2026-07-20 [alysia-architecture-plan](superpowers/plans/2026-07-20-alysia-architecture-plan.md)

## 🔗 持续更新的契约文档

- [Web-API-Design](Web-API-Design.md) — Web 端接口契约（WebUI/桌面端对接依据）
- [CODE_REVIEW_FIX_PLAN](CODE_REVIEW_FIX_PLAN.md) — 代码自检问题清单与修复记录

## 🗂 快速导航

| 想了解什么 | 看哪个 |
|-----------|--------|
| 整体架构 / 模块划分 | architecture-design |
| 记忆怎么存、怎么检索、怎么提炼 | memory-system-design |
| 新功能要先查什么 | Web-API-Design（接口契约）|
| 服务端有哪些能力 | server-optimization + 各系统 spec |
| 踩过的坑 / 平台限制 | 各 spec 的"已知限制/待办"节 |

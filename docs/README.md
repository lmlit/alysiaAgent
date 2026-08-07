# Alysia Agent — 文档总索引

> 通过本索引可检索当前项目的**所有设计思路与状态**。
> 2026-08-07 起采用 **OpenSpec 治理体系**：spec 是活的，每个变更走 propose → apply → archive。
> 开发纪律见 [openspec/project.md](../openspec/project.md)（必读）。

## 📚 Spec（OpenSpec 活 spec）

→ **入口：`openspec/specs/index.md`**（19 个子系统 spec + 状态表）

| 系统 | spec 路径 | 状态 |
|------|-----------|------|
| 记忆系统 | [openspec/specs/memory-system/spec.md](../openspec/specs/memory-system/spec.md) | active |
| 总体架构 | [openspec/specs/alysia-architecture/spec.md](../openspec/specs/alysia-architecture/spec.md) | active |
| AI 主动生活系统 | [openspec/specs/ai-life-system/spec.md](../openspec/specs/ai-life-system/spec.md) | active |
| 角色系统 | [openspec/specs/role-system/spec.md](../openspec/specs/role-system/spec.md) | active |
| 主动消息 | [openspec/specs/proactive-messages/spec.md](../openspec/specs/proactive-messages/spec.md) | active |
| 图片识别（Vision） | [openspec/specs/vision-bridge/spec.md](../openspec/specs/vision-bridge/spec.md) | 2026-08-07 补 |
| 提醒工具 | [openspec/specs/reminder-tool/spec.md](../openspec/specs/reminder-tool/spec.md) | 2026-08-07 补 |
| 其余 12 个 frozen/parked | [openspec/specs/index.md](../openspec/specs/index.md) 全表 | — |

## 🔗 持续更新的契约/流程文档（非 spec）

| 文档 | 说明 |
|------|------|
| [Web-API-Design](Web-API-Design.md) | Web 端接口契约（★ 新增/修改 core 方法必须先对照） |
| [Docker-Deployment](Docker-Deployment.md) | 服务端版本更新 SOP（部署流程） |
| [CODE_REVIEW_FIX_PLAN](CODE_REVIEW_FIX_PLAN.md) | 代码自检问题清单与修复记录 |

## 🗂 快速导航

| 想了解什么 | 看哪个 |
|-----------|--------|
| 开发纪律 / change 流程 | [openspec/project.md](../openspec/project.md) |
| 整体架构 / 模块划分 | openspec/specs/alysia-architecture/spec.md |
| 记忆怎么存、怎么检索、怎么提炼 | openspec/specs/memory-system/spec.md |
| AI 主动生活系统（LifeService） | openspec/specs/ai-life-system/spec.md |
| 新功能要先查什么 | openspec/specs/index.md + Web-API-Design（接口契约） |
| 服务端有哪些能力 | openspec/specs/index.md 各 frozen spec |
| 历史实施计划（已归档） | [openspec/archive/legacy/](../openspec/archive/legacy/) |
| 踩过的坑 / 平台限制 | 各 spec 的"已知限制/待办"节 |

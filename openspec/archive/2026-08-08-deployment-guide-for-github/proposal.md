# Change Proposal: deployment-guide-for-github

## 元信息

- **日期**: 2026-08-08
- **类型**: DOC（纯文档——对外部署指南）
- **状态**: archived（2026-08-08 归档）
- **影响 spec**: 无（新文档，非 spec 变更）

## 动机（为什么做）

现有 `docs/Docker-Deployment.md` 是**内部部署 SOP**（含私有服务器 IP/账号/密码/AppID），
不能给 GitHub 其他人使用。项目没有面向外部使用者的部署文档（无 README.md、USAGE.md
只有配置说明无完整部署流程）。

## 需求（做什么）

- [ ] 新建 `docs/DEPLOYMENT.md`——给 GitHub 使用者的部署指南（**零私有信息**）：
  - 方案一：本地部署（Node/pnpm 直接跑，含 QQ 开放平台注册指引、ownerId 语义——openid 非 QQ 号）
  - 方案二：服务器部署（Docker：构建/导出/上传/load/compose，通用占位符）
  - 环境变量清单（.env.example 已通用化）、config.example.yml 使用说明
  - 常见问题（token 失败/端口/持久化）——从私有 SOP 提取通用部分
- [ ] 不修改任何私有配置文档内容（Docker-Deployment.md 保持内部版）

## 设计决策

- 新文档与内部 SOP 分离：`docs/DEPLOYMENT.md`（对外通用）vs `docs/Docker-Deployment.md`（内部私有）
- 所有服务器地址/账号/AppID 用占位符（`<your-server>` / `<your-app-id>`）
- 不涉及代码改动，不涉及 Web API

## 测试计划

- 文档步骤按 README 快速开始实际跑通（本地 dev 启动）
- 检查全文无私有信息（IP 121.41.111.120 / hexi / AppID 1905266603 / 密码）

# Tasks: disable-publishing

> 关的是**投递机制**（工具+项目+runner），**不是**日记内容。见 proposal.md

## 实现
- [x] `config.ts`：`features.publish?: boolean`（注释写明默认 false 与 projects 的关系）
- [x] `modules/core.ts`：`publishingEnabled()` 纯函数；`projectIds` / `hostPages` / `serverStatus` 三处受控
- [x] `modules/self-activity.ts`：她自己发起项目同样受控
- [x] 启动日志：开/关各一行（关时 warn，并说明"配置与宿主页面保留不动"）

## 测试
- [x] `publishing-switch.test.ts` 2 例（缺省关闭 / 只认显式 true）
- [x] 本地真机：日志出现「页面/博客发布能力：**已关闭**」，且**无**「已注册页面查询工具」
- [x] 全量 **170 文件 / 1977 用例**

## 部署
- [x] `pnpm deploy`（smoke 闸；`rollback-20261025-182610`）
- [x] 部署后核对生产：日志「页面/博客发布能力：**已关闭**」；「页面查询工具」那行**消失**（此前每次启动都有）
- [x] 归档到 `openspec/archive/2026-10-25-disable-publishing/`

## 明确不做
- ❌ 不删 `config.projects`（那是宿主侧真实配置）
- ❌ 不动宿主上已有的页面/博客文章
- ❌ 不停写公开日记（那是内容层，用户关的是投递层）
# Change Proposal: webui-frontend-shell

## 元信息

- **日期**: 2026-08-15
- **类型**: NEW（新功能）
- **状态**: archived
- **影响 spec**: `webui-system`（新建：WebUI 前端壳 + 管理面板 + 聊天视图）

## 动机（为什么做）

WebUI PRD（docs/WebUI-PRD.md）一期 M1-M3：Vue 3 SPA 骨架 + 管理面板 11 页 + 聊天视图。
M0（streaming pipeline + chat 端点）已完成。本 change 交付前端全部页面 + 服务端静态托管。

## 需求（做什么）

- [x] `packages/webui` Vue 3 + Vite + Pinia + vue-router SPA（hash 路由，Electron/静态托管兼容）
- [x] 设计 token 体系（tokens.css：星穹紫金/晨光/午夜 3 主题，`data-theme` 切换，组件只消费 `--aw-*` 语义别名）
- [x] API client（unary + SSE 封装）+ 各域 API（api/modules.ts，扩展点：二期新增 programming.ts）
- [x] 导航模块表 modules.ts（扩展点：二期加一行 + views/programming/）
- [x] 通用组件池（SectionCard/JsonView/ConfirmButton/EmptyState/Tag/Table + useAsync）
- [x] 管理面板 10 页：画像/人格(参数+旋钮调整)/生活/世界书(删除)/模板(删除)/角色(切换+导入)/知识库(导入+删除)/会话/Token 统计/表情包
- [x] 聊天视图：会话侧栏(webui: 前缀过滤)+ 消息流(历史加载/加载更早)+ 流式发送(SSE chunk/done/aborted 帧)+ 表情包标记渲染 + 停止按钮(AbortController)
- [x] 服务端静态托管：Fastify 同源 serve webui/dist（hash 路由只需 index.html，产物缺失静默跳过）
- [x] 表情包文件端点 `GET /api/stickers/file/:name`
- [x] 构建验证：vite build 全页通过；pnpm -r build 0 错误

## 设计决策

1. **hash 路由**：file://（Electron 壳）与 http 托管都兼容，无需 history fallback
2. **主题 3 套**：token 化（抄 dsh ui-theme 纪律），localStorage 记住，`data-theme` 切换
3. **聊天走 SSE + on_done 收尾**（M0 契约）：aborted 帧显示"回复被打断"
4. **会话列表过滤 webui: 前缀**：与 QQ 通道隔离展示

## 对账方向确认

- [ ] 与现有 spec 冲突？无——新建 webui-system spec
- [x] 涉及 Web API？`GET /api/stickers/file/:name` 端点 + ChatView 使用 chat 端点（Web-API-Design.md 已登记 chat 端点，补 sticker 文件端点）

## 测试计划

- [x] vite build 全页编译通过
- [x] server webui 测试全绿（7 个 chat 端点测试）
- [x] 全量回归 + build 0 错误

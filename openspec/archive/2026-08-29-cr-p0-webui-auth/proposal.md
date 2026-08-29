# Change Proposal: cr-p0-webui-auth

## 元信息

- **日期**: 2026-08-29
- **类型**: FIX（安全加固）
- **状态**: proposed
- **影响 spec**: `server-hardening`

## 动机（为什么做）

CR 2026-08-29 P0-2：WebUI 管理面板全部 `/api/*` 路由零鉴权且监听 `0.0.0.0`。公网服务器部署下，任意设备可读取全部画像、人格、会话消息、Token 用量，可删除知识库/世界书/生活模板、切换角色、开关隐私模式，并可经 `/api/chat/stream` 无限消耗 LLM 额度。

## 需求（做什么）

- [ ] config.yml 新增 `webuiToken`（`${ALYSIA_WEBUI_TOKEN}` env 注入，与 ownerId 同机制）
- [ ] 所有 `/api/*` 路由校验 `Authorization: Bearer <token>`；缺失/错误 → 401
- [ ] 服务模式（非桌面）未配置 token → 启动 logger.warn + API 全拒（fail closed，杜绝零鉴权裸奔）
- [ ] 桌面模式（ALYSIA_DESKTOP=1，绑 127.0.0.1）免鉴权，保持本地工具体验
- [ ] WebUI 前端 api client 支持携带 token（登录交互，localStorage 持久化）

## 设计决策（怎么做，含备选与取舍）

- **不采纳"默认绑 127.0.0.1"**：Docker 部署时 WebUI 入口是宿主端口转发，容器内必须监听 0.0.0.0——localhost 绑定与 Docker 场景矛盾。鉴权才是正解。
- **fail closed**：服务模式无 token 时拒绝 API（401）而非放行——安全正确行为优先，启动日志给出配置指引。
- **静态资源不鉴权**：SPA 前端本身可加载，数据保护点在 API；前端登录后 localStorage 存 token 附加到请求头。
- 401 统一 JSON `{ error: 'unauthorized' }`，不泄露端点信息。

## 对账方向确认

- [x] 现有 spec 未声明 WebUI 鉴权设计 → 本 change 在 server-hardening 新增约束，无冲突
- [x] 涉及 Web API？鉴权是传输层行为，不新增/修改 core 方法；契约文档状态标记需同步

## 测试计划

- server 集成测试：无 token → 401；错误 token → 401；正确 token → 200
- 桌面模式（ALYSIA_DESKTOP=1）→ API 免鉴权通过
- 无 token 配置启动 → 日志告警可见

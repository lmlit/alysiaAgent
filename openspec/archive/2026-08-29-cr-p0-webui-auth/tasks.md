# Tasks: cr-p0-webui-auth

## 实现任务

- [ ] config.ts 加载 webuiToken（env 注入）
- [ ] webui/server.ts 全局 auth 钩子：/api/* 校验 Bearer
- [ ] bootstrap 服务模式无 token → warn；桌面模式免鉴权
- [ ] webui 前端 api client 支持 token 头（localStorage）
- [ ] server 集成测试（401/200/桌面模式）

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/server-hardening/spec.md`
- [ ] 更新 `openspec/specs/index.md`（状态/最后变更）
- [ ] 运行测试验证

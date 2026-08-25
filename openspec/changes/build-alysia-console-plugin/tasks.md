# Tasks: build-alysia-console-plugin

> 每个任务完成后勾选;全部完成后 apply(合并 spec)→ archive。
> 实现走执行工具(subagent-driven-development / TDD),本文件只记账。

## 实现任务

- [ ] 建包 `packages/dsh-console`(标准 bundle 单包:package.json + cordis.patch.yml + src/,仿 dsh-whale-widget 骨架)
- [ ] host 侧 `src/index.ts`:inject webServer;静态托管 `/alysia-console/*`;`tapIndex` 注入入口脚本(去重)
- [ ] host 侧 API 反代:`/alysia-api/*` → `http://127.0.0.1:6185/api/*`(方法/路径/响应头透传,超时与错误处理)
- [ ] client 侧控制台入口:悬浮按钮(仿鲸鱼自启,拖拽可选)→ 面板抽屉
- [ ] 面板页 1:昔涟画像(profile 快照 + persona 调整)
- [ ] 面板页 2:会话管理(list/archive/delete + 提取)
- [ ] 面板页 3:世界书 + 生活模板(list/add/delete)
- [ ] 面板页 4:记忆旋钮(adjustMemoryConfig 表单)
- [ ] 面板页 5:审计/状态(可选,stats/日志)
- [ ] 皮肤联动:样式全部 `--dsw-alias-*` token(默认值回退),换肤即变色
- [ ] 单元测试(host 侧:反代转发 / tapIndex 注入 / 静态托管)
- [ ] 手动验收:控制台打开、各页数据读写、旋钮生效、换肤变色

## Apply 任务(实现完成后)

- [ ] 合并 spec.md 到 `openspec/specs/dsh-adapter/spec.md`(新增 §6)
- [ ] 更新 `openspec/specs/index.md`(dsh-adapter 行最后变更)
- [ ] 运行测试验证

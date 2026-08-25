# Change Proposal: dsh-alysia-adapter-mvp

> 把 Alysia 昔涟人格/记忆系统接入 DeepSeek Harness(dsh)的第一步——最小可验证闭环。
> 背景见 `docs/dsh-migration-guide.md`;方案讨论见会话记录(PRD: AlysiaAgent DSH 插件化)。

## 元信息

- **日期**: 2026-08-25
- **类型**: NEW(新功能)
- **状态**: archived
- **影响 spec**: `dsh-adapter`(新建 spec)

## 动机(为什么做)

用户决定将 alysia 开发迁移到 dsh(现有 Electron 窗口模式舍弃)。已对 dsh 源码完成验证:
- `ctx.systemPrompt.section/context/variable/tools` 全部存在(modules 与 PRD 一致)
- `ctx.tools.register()` 要求 `ToolDefinition` 必须带 `output {schema, render}` 硬约束
- `AssembleContext` 只有 `{scope?, signal?}`,不含用户消息(需缓存)
- 消息 hook:`session/event`(含 `user/message`/`assistant/message`)+ `session/disposed`(会话结束)
- agent-presets = composition 文件(Include 加载,支持绝对路径),`@deepseek-ai/dsh-persona` 提供 `complete`/shadow 两种 persona 覆盖
- `@deepseek-ai/cordis` 4.0.1 已发布 npm,插件依赖可直接安装

**最大未知项**:自定义插件在 dsh 里的完整生命周期(加载→persona→工具→事件)。MVP 只验证这个闭环,数据层(真实记忆/写库)放二期。

## 需求(做什么)

- [ ] 新建包 `packages/dsh-adapter`(cordis 插件,运行时零原生依赖,better-sqlite3/LanceDB 不引入)
- [ ] 插件注册 persona section(`deployment:persona` shadow 内置昔涟人设文本)
- [ ] 注册 `alysia:memory` context provider(骨架,一期返回空;二期接 server API 检索)
- [ ] 注册 `alysia_life` variable(骨架,一期不引用;二期注入生活事件)
- [ ] 注册 `recall_memory` 工具(全链路验证 tools.register 的 output 硬约束;一期 stub 返回占位)
- [ ] 监听 `session/event`(user/message + assistant/message)与 `session/disposed`,日志验证 ingest hook
- [ ] 提供 agent preset(`alysia` chat composition + 元数据),dsh roster 可发现/选中
- [ ] 单元测试:mock context 下断言 4 类注册发生
- [ ] 手动验证:dsh web 启动 → 选中 alysia preset → 聊天呈昔涟人格 → LLM 调用 recall_memory → 日志见事件

## 设计决策(怎么做,含备选与取舍)

1. **插件放 alysiaAgent monorepo**(`packages/dsh-adapter`),不侵入 dsh 源码树
   → composition 行用绝对路径引用(mount.ts 明确处理 Windows drive-letter 路径)。被否决:直接改 dsh 的 apps/cli config(污染上游,无法跟随 dsh 升级)。
2. **依赖装 npm 已发布的 `@deepseek-ai/*`**(cordis 4.0.1 正式版)
   → 被否决:pnpm workspace `link:` 指 dsh 本地树(依赖未发布包路径,脆弱)。
3. **MVP 不含数据层**(不连 SQLite/LanceDB、不加 server API 端点)
   → 插件零原生依赖、无双进程/会话映射问题,专注验证唯一未知的插件生命周期。真记忆检索 + ingest 写库走 `server API 代写层`(二期 change),届时 context/tool 实现换为 HTTP 调用,骨架接口不动。
4. **persona 用 shadow 而非 `complete: true`**
   → 保留 dsh harness identity 段,调试期信息完整;`complete` 只裁剪 sections,不影响 contexts/tools/variables 组装,二期不受限。
5. **事件监听在 preset 内挂载** → scoped 监听天然只收本 agent 的 session 事件,不用手动过滤 agent。
6. **被否决:一期接真实记忆** —— 需要 server 端 `/api/memory/read` + ingest 端点 + 会话 id 映射,超出"最小"范围;且 MVP 目的不是数据正确性,是链路打通。

## 对账方向确认

- [x] 是否与现有 spec 冲突?无 spec 覆盖 dsh 适配 → **新建 spec `dsh-adapter`**(NEW 类型)
- [x] 涉及 Web API?一期**零 server 改动**,不涉及 `docs/Web-API-Design.md`(二期加代写层时再对照)

## 测试计划

1. 单元:`packages/dsh-adapter` vitest —— 在 mock 注册表上断言 section/context/variable/tool/事件监听 5 类注册被调用
2. 手动:dsh web 启动 → 新 preset 出现在 roster → 选中聊天:
   - 回复呈昔涟人格(非 dsh 默认 coding-agent 口吻)
   - 提示 LLM 调用 `recall_memory`(如"查询你的记忆"),返回 stub 结果,无 `UNKNOWN_TOOL`
   - 服务端日志出现 `session/event`(user/message、assistant/message)与 `session/disposed` 记录

# Tasks: dsh-alysia-adapter-mvp

> 每个任务完成后勾选;全部完成后 apply(合并 spec)→ archive。
> 实现走执行工具(subagent-driven-development / TDD),本文件只记账。

## 实现任务

- [x] 建包 `packages/dsh-adapter`(package.json/tsconfig/vitest;deps:`@deepseek-ai/cordis` + `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-tools` + `@deepseek-ai/schemastery` + `@alysia/core`(仅日志))
      ★ 实际:依赖收敛为运行时仅 `@deepseek-ai/cordis`(npm 版 dsh 包链断,dsh-type-meta 404);persona 常量/工具类型自定(与 dsh rc.7 对齐)
- [x] 插件入口 `src/index.ts`:`name`/`inject`/`Config`/`apply(ctx, config)`
      ★ 实际:加了 `inject = ['systemPrompt', 'tools']`(cordis 4.0.1 ctx 是 Proxy,未 inject 访问即抛)+ `Config.persona` 开关(全局平面同名冲突规避)
- [x] persona section:`systemPrompt.section({name: PERSONA_SECTION, order: PERSONA_ORDER, text: 昔涟人设})`(shadow,非 complete)
- [x] context 骨架:`systemPrompt.context({name: 'alysia:memory', order, text: provider})`——一期返回空字符串
- [x] variable 骨架:`systemPrompt.variable('alysia_life', provider)`——一期不引用
- [x] 工具 `recall_memory`:`tools.register()`——含 `output: {schema, render}`,一期 stub 返回占位信息
- [x] 事件监听:`ctx.on('session/event')` 过滤 `user/message`/`assistant/message` 打日志;`ctx.on('session/disposed')` 打日志
- [x] agent preset:`presets/alysia/agent.cordis.yml` + `preset.yml`(中文元数据)
- [x] 单元测试:mock context 断言 5 类注册被调用(9/9 通过)
- [x] 手动验证:
      - [x] dsh web 启动(需 Node 24——zstd 需 22.18+,shell 默认 Node 20 会挂)
      - [x] roster 扫描确认 alysia preset 被发现且健康(scanRoot 直调)
      - [x] headless 挂载插件跑通:LLM 主动调用 recall_memory 并融入回复(最强链路验证)
      - [x] host 平面 Include 不支持 Windows 裸绝对路径 → file:// URL(已记入 dev patch 注释)

## Apply 任务(实现完成后)

- [x] 合并 spec.md 到 `openspec/specs/dsh-adapter/spec.md`
- [x] 更新 `openspec/specs/index.md`(新增 dsh-adapter 行 + 最后变更)
- [x] 运行测试验证

# Tasks: make-stop-really-stop

- [x] `commandsModule`：`inject: ['al:memory', 'al:coalescer']`
- [x] `/stop` 接 `AbortRegistry.abort(sessionId)`，日志区分 `aborted` / `nothing in flight`
- [x] **顺带修假回话**：`createSessionCommands` 的 `onStop` 改为可返回文案，
      两种结果分别回「已中断正在生成的回复。」/「此刻没有正在生成的回复（无需中断）。」
- [x] 测试 `tests/modules/capabilities.test.ts`：`/stop` 真的 abort + 两种回话都断言
- [x] `alysia-architecture` §6.3 / §6.3.1：命令表 + 中断契约 + **「中断不了工具副作用」的诚实边界**
- [x] 全量测试（Node 24，免 API 一遍）：135 文件 / 1716 测试全绿
- [x] 归档 + 更新索引 + KI-7 + TODO 销账

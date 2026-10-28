# Tasks: add-production-trace-eval

- [x] 建 `packages/core/tests/eval/production-trace.test.ts`
- [x] 预算场景：100 facts + 3 recent + 5 memories + life + 1.2k basics，3200 预算
- [x] 冷却场景：60s 一轮 × 25min → 3 次请求
- [x] skipped/failed 的 hold 判据
- [x] 全量测试：**172 文件 / 1995 用例全绿**；预算场景 `dropped = (none)`
- [x] 归档

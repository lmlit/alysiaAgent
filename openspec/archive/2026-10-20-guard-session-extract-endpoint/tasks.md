# Tasks: guard-session-extract-endpoint

- [x] `MemoryManager.countSessionEvents(sessionId)`：包装 `EventStore.countBySession`
      （`EventStore` 层已有既有单测覆盖，本 change 不重复造）
- [x] `docs/Web-API-Design.md` §2.2 登记该方法 + 四种状态码
- [x] 路由层：空 id / 解码后含 `/` → 400；`dsh:unknown` → 400；零事件 → 404（带原因）
- [x] 测试 `packages/server/tests/extract-endpoint-guard.test.ts`（4 条：
      正常路径不回归 / 零事件 404 / `dsh:unknown` 400 / 畸形 id 400）
- [x] `server-hardening` spec 新增 §7（5 条契约）
- [x] 全量测试（Node 24，免 API 一遍）：135 文件 / 1716 测试全绿
- [x] 归档 + 更新索引 + KI-18 + TODO 销账

# Tasks: fix-empty-embed-query

- [x] `MemoryManager.read`：空 query 走文本检索，不请求 embedding（`debug` 级日志）
- [x] `modules/resources.ts` 的 `embed`：空文本不发请求，抛 `embed: 空文本（调用方应在调用前跳过 embedding）`
- [x] 测试 `packages/core/tests/embed-empty-guard.test.ts`（4 例）
- [x] core 全量 **980** 绿（新加 4 例后为 984；见最终跑数）
- [x] 部署：core `MemoryManager.js` + `modules/resources.js`
- [x] 真机验证：`POST /api/memory/read {"query":""}` → `[memory/read] query="" → 召回 5 条`，
      **无** `Embed API error 400`、无 WARN
- [x] `docs/TODO.md` 的 B 节条目改为"已修（本 change）"

## 判据留痕

判断"是逻辑错而不是 API 变更"的依据：同一次日志里，**非空**查询的召回一直是成功的
（否则 `[Recall]` 统计与聊天回复早就明显退化）；只有空 query 那几次是 400。

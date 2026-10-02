# Tasks: record-dsh-as-coding-mode

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 来源标记

- [x] dsh 回传 `source: 'chat'` → **`'code'`**
      —— `EventSource` 已有该值，且 `RealtimeProcessor:41` 已按它分流世界书 scope
- [x] `alysia-client.ts` 的 `IngestEvent.source` 类型收紧为 `'code'`
- [x] 插件测试断言改为 `source === 'code'`
- [x] server 测试补显式用例：`/api/ingest` 接受 `source: 'code'`

## 定位写入 spec

- [x] `alysia-architecture` §1.1：修正「砍掉编程模式」——
      当时的决定（不做自建 Electron 壳）仍成立，**变的是承接方 = dsh**
- [x] `CLAUDE.md`：编程模式补一句「由 DeepSeek Harness 承接」

## 验收（2026-10-02）

| 项 | 结果 |
|---|---|
| adapter | ✅ **66 passed** |
| 真全仓 | ✅ **962 passed**（+1 source 用例） |
| core / server / adapter tsc | ✅ 全过 |
| dist | ✅ 已重建（`source: 'code'` 已在产物里） |

## 设计上**刻意没做**的

- ❌ **不给 `EventSource` 加值** —— `'code'` 本来就在，加值会让所有 switch 它的下游出现未覆盖分支
- ❌ **不加 `payload.origin`** —— 标记了没消费就是「声明了没接」，本项目对账规则明令禁止
- ❌ **不跳过人格自适应** —— 编程也是相处，她的性格**该**被这段经历影响；
      一刀切跳过反而违背人设自适应的设计意图

## 遗留

- **`source: 'code'` 目前只有一个消费点**（世界书 scope 分流）。将来若要按来源做更多事
  （如「编程对话不进 `[最近对话]` 块」），数据已经在库里了，不必回填。
- **存量 dsh 事件仍是 `'chat'`**（今天之前回传的）。量小（26 条），
  要不要订正取决于后续消费规则是否受它影响；目前唯一的消费点（世界书）只影响**实时匹配**，
  不回看历史，所以**不需要订正**。

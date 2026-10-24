# Tasks: align-dsh-memory-blocks-with-scope

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 方案已拍板 **A（拆参数）**，见 `proposal.md` §设计决策；排序决定 **P1 独立先做、不等 P8**。
> ⚠️ 本 change **没有 `spec.md`**（与 `tune-zero-row-checks` 同款做法）：spec 的改动
> **已直接并入活 spec**（`specs/dsh-adapter/spec.md` §2.2 + `specs/memory-system/spec.md` §7）。
> 这是**有意的省略**，不是漏了 —— 本 change 只改两个**可选字段**与一段注入逻辑，无新子系统。
> 🚫 **归档时不要再"读 change 的 spec.md 并合并"**：已经并入过一次，重复合并会把那两段**插两遍**。

## 实现任务

- [x] **core · 块表参数化**：`PromptAssembler.assemble()` 增加第 6 个参数
      `opts: AssembleOptions = { blocks?, worldbookScope? }`；`blocks` 缺省回落 `mode`。
      **没有拆成两个函数** —— `mode` 保留为糖，旧调用方（QQ/console/自带 pipeline）零改动
- [x] **core · chat 表接 worldbook**：`assembleChat` 注入 `[情境提示]`（optional，
      插入位置 = `[最近对话]` 之后、`[我的近期日常]` 之前，与 `assembleCode` 同序）。
      filter **按传入的 `worldbookScope` 决定**（`code` → `code|both`；`chat` → `chat|both`），
      **没有硬编码 `'code'`**；排除 `content_type === 'image'`
- [x] **core · 缺省即现状（守卫合并在这里）**：`blocks='chat'` 且**未给** `worldbookScope`
      ⇒ 不注入，与改动前逐字相同；一旦"给了 scope 却没注入"→ `warnThrottled`
      （`PromptAssembler.worldbookTrivial`），防它再退化成静默死参数
- [x] **core · code 表不动**：`blocks='code'` 维持现状（隐式 code scope + 注入），
      **`worldbookScope` 对它无效**；报告里如实回填注入条数
- [x] **core · 报告**：新增 `assembleWithReport()` → `{ text, dropped, worldbookInjected }`。
      `dropped.includes('worldbook')` 时 `worldbookInjected` **必须为 0**
      （不许拿"匹配数"冒充"注入数"—— 那正是这个 bug 能藏 22 天的原因）
- [x] **server · 端点**：`POST /api/memory/read` 接收 `blocks?` / `worldbookScope?`；
      非法值按缺省处理、**不透传垃圾值**；`MemoryManager.read()` 的 worldbook 匹配
      按 `req.worldbookScope ?? req.mode` 取值
- [x] **server · 观测**：`[memory/read]` 行改成
      `… worldbook 匹配 N 注入 M 条 / blocks=… scope=… / 预算丢弃 …`
- [x] **dsh-adapter · 调用方**：`readMemory()` body 加 `blocks: 'chat'`, `worldbookScope: 'code'`
- [x] **文档 · Web 契约**：`docs/Web-API-Design.md` §2.4.4 补两个字段 + 缺省语义 +
      兼容说明 + dsh 调用形态 + 观测口径
- [x] **文档 · spec**：`openspec/specs/dsh-adapter/spec.md` §2.2 写清
      「dsh 自动注入 code-scope 世界书；QQ/console 仍走 `lookup_worldbook` 工具」的**理由**
      （防止下次对账把它判成不一致）
- [x] **文档 · 现状底账**：`docs/PROMPT-INVENTORY.md` §2 路径表 / §3.1 块表 / §6.1 静默断点

## 测试任务

- [x] `packages/core/tests/memory/unit/worldbook-injection.test.ts`（6 例）
      —— 不给 scope 不注入 / code 只命中 code+both / chat 只命中 chat+both /
      排除 image / 预算丢块时回 0 / code 表行为不变 / `blocks` 能覆盖 `mode`
- [x] `packages/server/tests/memory-read-blocks.test.ts`（4 例）
      —— 不传新字段 = 旧行为 / dsh 形态双字段透传 / `blocks` 独立于 `mode` / 非法值不炸
- [x] `packages/dsh-adapter/tests/read-memory-body.test.ts`（2 例）
      —— 请求体必须带两个字段（含**空 query 的预热**，否则第一轮世界书仍进不来）
- [x] **QQ / console prompt 快照不变**（`prompt-assembler-characterization.test.ts` 4 例全绿）
- [x] 全量回归：**157 文件 / 1862 用例全过**（Node 24）

## 实施记录（2026-10-24）

| 文件 | 改动 |
|---|---|
| `packages/core/src/memory/PromptAssembler.ts` | `ChatBlockKey` + `worldbook`；`CHAT_BLOCK_POLICY` + `worldbook: 'optional'`；新增 `AssembleOptions` / `AssembleReport` / `assembleWithReport()`；`assembleChat` 接 `worldbookScope` 并注入；`assembleCode` 返回报告 |
| `packages/core/src/memory/MemoryManager.ts` | `read()` 用 `worldbookScope ?? mode` 匹配；`assembleWithWorldbook()` 加 `opts`；新增 `assembleWithReport()`（隐私模式返回空报告） |
| `packages/core/src/memory/types.ts` | `MemoryReadRequest` + `blocks?` / `worldbookScope?`（含"一词三义"说明） |
| `packages/server/src/webui/server.ts` | `/api/memory/read` 解析两字段 + 用 `assembleWithReport` + 日志区分匹配/注入 |
| `packages/dsh-adapter/src/alysia-client.ts` | `readMemory()` 传 `blocks: 'chat'` + `worldbookScope: 'code'` |
| `docs/Web-API-Design.md` | §2.4.4 重写请求形状 + 拆参数理由 + 观测口径 |
| `openspec/specs/dsh-adapter/spec.md` | §2.2 补 dsh 显式传参的理由 + "两会话行为不同是有意的" |

## Apply 任务（实现完成后）

- [x] spec 改动**直接并入活 spec**（无 change 内 `spec.md`，理由见文件头）
- [x] 更新 `openspec/specs/dsh-adapter/spec.md` §2.2
- [x] 运行 `scripts/check-spec-diff-residue.cjs`（exit 0，无残留）
- [x] 运行全量测试（Node 24：`E:\nodejs24\node.exe`）→ 1862 全过
- [x] 更新 `docs/PROMPT-INVENTORY.md`（现状底账必须跟着改，否则它立刻变谎话）
- [x] **归档**（`/openspec-archive`）：移到 `openspec/archive/` + 更新 `specs/index.md` + 删 PLAN 的 P1 行
- [x] ~~真机验收：在 dsh 会话里确认 `[memory/read] … worldbook 匹配 N 注入 N 条` 且 N > 0~~
      ❌ **取消**（2026-10-24 方向变更：dsh 通道已停用；且实测库里 `scope='code'` = **0 条**、
      `both` 的 14 条全是 `life_event` ⇒ 该判据本来就**不可达**）

# Tasks: bridge-memory-read

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 排查（用户报告「记忆没有继承」）

- [x] 查日志 → 服务被我误删了日志文件，看不到（**我的疏忽**，已改用不会被删的路径）
- [x] **不靠日志也能定位**：直接读代码
- [x] `alysia:memory` context provider → `return ''`（2026-08-25 的 MVP 占位）
- [x] `recall_memory` 工具 → `{ memories: [], note: '二期接入' }`（同为 stub）
- [x] 查库确认**写通道是好的**：`dsh:session-*` 19 + 7 条事件已入库
      → **不是坏了，是读通道从来没接**

## alysia server

- [x] `POST /api/memory/read`：`{ query, mode?, limit?, sessionId? }` → `{ context, retrieved }`
      - `context` 由 `read()` + `assembleWithWorldbook()` 组装，**与聊天管线同一套**
      - **空 query 也照常返回**（`[关于你]` 等块不依赖 query）——这是 dsh 侧预热的前提
      - 每次调用记一行日志（含 query 摘要/召回数/context 长度）

## dsh 插件

- [x] `alysia-client.readMemory(query, sessionId?)`
- [x] `recall_memory` 改成工厂 `createRecallMemoryTool(client)`，`execute` 打真实接口
      - **服务不可达 → 返回 note 而不是抛**（她只是想回忆点事，不该让整轮工具调用失败）
      - 协作 `exec.signal`（已取消则不发请求）
- [x] `alysia:memory` context provider：**缓存 + 后台刷新**
      - **挂载时预热一次**（空 query）→ 第一轮就有记忆
      - `user/message` 到达后用**原话**刷新（话题相关）
      - 失败保留旧值（**provider 同步返回，宁可旧不可空/抛**）

## 测试

- [x] `tests/index.test.ts` 新增 8 条（记忆缓存/预热/失败保留/关闭开关）+ `recall_memory` 真实路径 5 条
- [x] `tests/alysia-client.test.ts` 补 `readMemory`（含失败/空值路径）
- [x] 修既有测试：回传断言的基线要把**预热与刷新的 `/api/memory/read` 调用**分流出去

## ★★ 顺带发现：根测试配置漏了两个包

`vitest.config.ts` 的 `projects` 只有 core / server / console ——
**`dsh-adapter` / `dsh-console` 从来没被根 `npx vitest run` / `pnpm test` 跑到**。

后果：**我这次会话报的所有「全仓 N 全绿」都不含 dsh-adapter 的 63 条**。
而这两个包恰恰是外层集成（dsh 事件形状映射、跨进程 HTTP 契约、bundle patch 结构），
**它们的错法不会让别的测试变红**。

- [x] 补进 `projects`

## 验收（2026-10-02，真启动实测）

| 项 | 结果 |
|---|---|
| 常规全仓（含补上的两个包） | ✅ **958 passed / 83 files**（此前报的 889 是**漏的**） |
| core / server / adapter tsc | ✅ 全过 |
| **预热查询**（空 query） | ✅ 200 / 0.34s / **context 2165 字 / 召回 5 条** |
| 内容正确性 | ✅ 含 `[关于你]` 的完整画像（「轻月…生活在长沙…KTC 27英寸2K显示器…」） |
| **真实 query** | ✅ 200 / 0.73s / 召回 5 条，返回真实记忆（旧照片、闲聊摘要…） |
| 服务端日志 | ✅ `[memory/read] query="..." → 召回 N 条 / context N 字` |

## Apply 任务

- [x] `docs/Web-API-Design.md`：补 §2.4.4 `POST /api/memory/read`
- [ ] `openspec/specs/dsh-adapter/spec.md`：把 §2.2/§2.4 的「二期」标记改为已落地
- [ ] `openspec/specs/index.md` 更新
- [ ] `docs/HANDOFF.md`

## ★ 用户实测后修的第 1 项：启动时 9 次重复预热（2026-10-02）

实测日志显示**一次启动打了 9 次 `/api/memory/read`**：
桌面端启动会**恢复多个会话**，每个会话挂一个插件实例，各做一次预热。
（对照：`alysia-persona` host 行 3～5 次；且启动后只有 1 个 agent 活跃，
所以只有它每 5 分钟刷新——**浪费集中在挂载那一波**。）

- [x] 预热结果提到**模块级共享**（同进程内多实例共用一次）
- [x] 加 `prewarmReuseMs` 旋钮（默认 30s；`0` = 每次重拉）
- [x] 只去重**预热**；带 query 的刷新是**逐会话**的，不去重（结果确实与会话相关）

### 修的过程中厘清的两层语义（都补了测试）

1. **去重是两层**：`in-flight`（同一 tick 的多个挂载复用同一个 promise，
   **窗口设 0 也只发一次**）+ 窗口缓存（隔开时间的挂载靠它）
   —— 启动那一波是被**第一层**消掉的
2. **成功就写缓存，窗口只管「要不要读」** —— 写反过一次
   （窗口=0 时连缓存都不写，紧接着用默认窗口的挂载又要重拉）

### 测试隔离的一个坑（值得记）

模块级状态（`prewarmCache` / `prewarmInFlight`）**会跨测试泄漏**：
上一个测试还在飞的预热 promise 被下一个测试复用 →
表现为「本测试一次请求都没发」，看着像实现坏了。
修法：记忆类测试用 `vi.resetModules()` + 动态 import 拿**全新模块实例**。

## 遗留 / 已知取舍

- **context provider 有 1 轮延迟**：dsh 的 provider 同步，检索含一次 embedding 远程调用
  （200-500ms），大概率输掉「用户消息 → prompt 组装」的竞态。
  预热解决了第一轮，后续轮次用的是**上一句**的检索结果——相邻几轮通常同话题，可接受。
  **要即时的让她调 `recall_memory`**（异步、带 query、准确）。
- **`alysia_life` 变量仍是 stub**（生活事件注入）。要做的话同这套缓存模式。

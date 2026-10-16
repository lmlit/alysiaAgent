# Tasks: fix-dsh-ingest-and-settlement

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。
> 分组 T1/T2/T3 **逐项独立验证**；每组都有「能复现旧问题」的测试（红→绿证据见下）。
> 纪律：只用虚构事件与合成数据；未联网、未外传；未执行的测试不标为通过。

## T1 投递可靠性（R1–R4）

- [x] T1.1 复现测试：积压 201 条 → 单请求直发（红：`expected 1 to be greater than 1`）
- [x] T1.2 `AlysiaClient.ingest` 改判别式联合（`ok` / `permanent` / `unreachable`），
      取消 `null` 语义；「永不抛出」不变（`requestRaw` 分流，读路径仍返回 `null`）
- [x] T1.3 新增 `packages/dsh-adapter/src/delivery.ts`（`IngestDelivery`）：
      分批 ≤ `SERVER_MAX_INGEST_BATCH`、在途 promise 链串行化、队列上限丢最旧、计数 + `stats()`
- [x] T1.4 `drain()` 返回覆盖在途批次的排空链；`turn/end` 仍不阻塞会话
- [x] T1.5 4xx（含 413）不进重试队列 + 响亮上报；413 标注为**契约漂移**
- [x] T1.6 部分成功：`accepted` 不重发、`rejected[]` 如实上报
- [x] T1.7 卡死/丢弃诊断独立于 `AlysiaClient` 的失败降噪；丢弃真实总数在下次成功排空时补报
- [x] T1.8 测试：201/500 条排空、断线恢复补发、4xx 不重试、部分拒收不阻塞
- [x] T1.9 更新 `tests/alysia-client.test.ts` 的 3 处旧 `null` 断言 + 新增分类用例

## T2 结算等待入库 —— KI-24（R5）

- [x] T2.1 复现测试：ingest 响应未返回时触发 `disposed` → 旧实现抢跑发 extract（红）
- [x] T2.2 `session/disposed` await 整条排空链后才 `extractSession`
- [x] T2.3 回传失败时不发 extract（**根本不尝试**），打明确 warn 且含会话 id
- [x] T2.4 挂起结算集合：下次成功排空后自动重试；同会话去重；尝试上限 3 次后明确失败
- [x] T2.5 测试 B1/B2/B3（顺序断言基于「响应已返回」）

## T3 身份缺失 fail closed —— KI-23（R6）

- [x] T3.1 复现测试：无 id 的 session → 旧实现发出 `dsh:unknown`（红）
- [x] T3.2 `sessionIdOf()` 返回 `string | null`，删除 `'unknown'` 字面量
- [x] T3.3 不回传、不结算 + 限频诊断（每类事件首次一行 warn）
- [x] T3.4 不阻断 dsh 自身：既有「回传失败不抛（会话照常跑）」用例继续通过
- [x] T3.5 服务端第二道闸：`/api/ingest` 拒收 `dsh:unknown`，原因具体
- [x] T3.6 测试 C1/C2/C3/D1；另加「不误伤 `dsh:unknownish-1` 这类真实 id」

## T4 KI-12（在既有 change `fix-store-write-trace` 内实现）

- [x] T4.1 该 change 的 `tasks.md` 已建，KI-12 项已勾 + 7 条不可变语义用例
- [x] T4.2 口径与本 change 的 R3/R4 一致（不覆盖、幂等空转）——已写入本 change spec 契约 9

## Apply 任务

- [x] A.1 合并 spec.md 到 `openspec/specs/dsh-adapter/spec.md`（§2.5 表格行 + §2.5.1 新增 + §4 表格行）
- [x] A.2 清掉 diff 标记（合并后 `grep '^\+ '` 零命中，已验）
- [x] A.3 更新 `openspec/specs/index.md`（dsh-adapter 行「最后变更」；KI-23/24 移出「尚未开 change」清单）
- [x] A.4 更新 `docs/KNOWN-ISSUES.md`：KI-12/KI-23/KI-24 标注已修 + 指向 change；
      KI-25 补记「后果已变」（覆盖 → 新事件被丢弃）
- [x] A.5 运行测试（**确切命令与结果见下**）
- [x] A.6 部署状态：**未部署**（见下）

---

## 验证记录（实际执行的命令与结果）

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| dsh-adapter | `npx vitest run`（`packages/dsh-adapter`） | **6 files / 100 passed** |
| dsh-adapter 类型 | `npx tsc --noEmit`（`packages/dsh-adapter`） | **exit 0** |
| server | `npx vitest run`（`packages/server`） | **13 files / 227 passed** |
| core | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run --exclude='tests/memory/e2e/*'`（`packages/core`） | **67 files / 654 passed**（exit 0） |

**红→绿证据**（改实现**之前**先跑新测试）：

- `201 条积压`：`expected 1 to be greater than 1`（单请求直发 201 条）
- `500 条积压`：`expected 500 to be less than or equal to 200`
- `4xx 永久拒收`：`expected 2 to be 1`（**同样的输入被重发了一遍**）
- `KI-24`：`回传还在飞就结算了`（extract 已发出）
- `KI-23`：`expected [ 'dsh:unknown' ] to not include 'dsh:unknown'`
- `KI-23 静默`：`expected 0 to be greater than 0`（零 warn）
- KI-12（另一 change）：`expected +0 to be 1`（`archived` 被回落 0）等 4 条

**环境备注（踩到过，记下来免得下一个人再花时间）**：

- 仓库根跑 `npx vitest` 会在 **`packages/console/vitest.config.ts` 上崩**
  （`std-env` 的 `ERR_REQUIRE_ESM`）——**与本次改动无关**，是既有问题。
  ⇒ 按包跑（`workdir: packages/<pkg>`）。
- 默认 `npx` 解析到的 Node 是 **v20.16.0**，而 `better-sqlite3` 原生模块是 **Node 24 ABI**
  ⇒ **core 测试必须用 `E:\nodejs24\node.exe`**（否则 `NODE_MODULE_VERSION 137 vs 115`）。
  dsh-adapter / server 无原生依赖，默认 Node 即可。
- core 全套首次运行报 `[exit code: 1]`（但 654 全绿）；随后两次复跑均 `exit 0`。
  **未复现，未归因**——记录在此，若再出现按独立问题查。

## 部署状态

**未部署。** 本轮只做代码与契约，未构建镜像、未重启服务、未碰线上数据。
`fix-store-write-trace` 的 KI-12 与同批其余 6 项同属**待发版**内容。
⚠️ `packages/console` 存在 19 个未提交改动，**发版时会连带进镜像**——
部署前需用户拍板（见 `docs/KNOWN-ISSUES.md` 的 `fix-reflection-insight-misroute` 归档项）。

## 已知边界（**没有**达成的部分，不许当成已解决）

1. **契约 6 的重试链随插件实例消失**：若实例在排空成功前被卸载，
   挂起的结算不会被补做——只保证「不结算 + 响亮失败」。已写进 spec 契约 6 的边界说明。
2. **KI-25 未决**：`event.seq` 跨 restart/resume 是否重数**仍无证据**，
   去重键**未改**。且 KI-12 修复后，撞 id 的后果从「覆盖」变成「**新事件被丢弃**」。
3. **KI-18 未动**：`/api/sessions/:id/extract` 仍对 session id 不设防
   （本 change 的结算路径正是打这个端点）。属既有安全 gap，计划第二批处理。
4. **KI-19 残留**：本 change 只对**挂起结算**做了同会话去重；
   「两个触发方并发 `process()`」是否要显式幂等，仍按 KI-19 的验证口径观察。
5. **★ 未做（原计划里明确列了，本轮没有验证）**：第一批 #2 还写着
   「**检查 cron 是否仍可能在迟到消息入库前推进摘要窗口**；若成立，单独补服务端防护」。
   本轮只把**适配器侧**的抢跑消除（契约 5：结算等确认落库），
   **没有**核查服务端 cron（`archiveStaleSessions` / `retryFailedSummaries`）是否会在
   dsh 在途消息尚未入库时推进摘要窗口 —— 那是一条**独立于适配器**的时序，
   适配器的串行化管不到它。**留作待办**：先构造判据
   （迟到事件的 `created_at` 是否仍可能落在新摘要 `ended_at` 之前），再决定要不要服务端防护。

# Tasks: unify-core-shutdown

> 本文件由「登记骨架」改写为「据实结算」。实现已完成，**但有一处验收未完成**（见末节）。

## 需求（原 proposal 的四项 + 顺序难点）

- [x] 给 `al:db` / `al:vector` 模块加停机 effect（`modules/resources.ts`）
      - `al:db` → `db.close()`（**确定性**）
      - `al:vector` → `LanceDBStore.close()`（⚠️ **尽力而为**，napi 无确定性释放原语）
      - 只在**真的建起来**时注册（降级路径给的是 `null`，没有东西可关）
- [x] **明确停机顺序** —— 读代码后确认：**不需要各模块自己排**
      - `al:db` 是**第一个装**的模块，而内核卸载是**严格逆序** ⇒ 它**最后一个卸**
      - 此刻 `al:memory` / `al:tools` / `al:commands` / 各 processor 都已卸完
      - 落成契约（`module-kernel` §2.3）：内核只提供「逆序 + await + 逐个兜错」的**执行**机制，
        **释放什么由模块用 `ctx.effect` 声明**
- [x] 处理「关太早」的新失败模式：better-sqlite3 在 `close()` 后用会**抛错**
      ⇒ 天然「明确失败」而非静默丢弃（已加用例断言）
- [x] 更新 `module-kernel`：§2.3 `stop()` 语义**扩写**（原 §5.1 只写了"这是行为变更，归独立 change"）
- [x] 不 catch 关闭失败：交给内核统一清理路径（`disposeEntry` 已 `logger.error` 且不中断其余）
- [x] **E2E 的 `afterAll` 去掉 `EPERM` 变通注释** —— ✅ **2026-10-16 晚已达成**（见上）

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| resources 定向 | `run tests/modules/resources.test.ts`（`packages/core`） | **20 passed**（本 change +4） |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **74 files / 729 passed**（本 change 前 725） |
| server | `npx vitest run`（`packages/server`） | 13 files / 227 passed |
| dsh-adapter | `npx vitest run`（`packages/dsh-adapter`） | 6 files / 102 passed |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

新增用例：
- `★ 停机时关闭 SQLite 句柄`：`stop()` 后 `db.open === false`
- `★ 「关太早」必须响亮失败`：`stop()` 后 `db.prepare(...)` 抛 `not open`
- `★ 停机时释放 LanceDB 句柄`：`stop()` 后 `store.ready === false` 且 `store.table === null`
- `★ 降级路径不注册关闭 effect`：`vectorStore === null` 时 `stop()` 不抛

## ✅ 那处验收**当天晚上就跑通了**（2026-10-16 晚补跑，真实 e2e）

> 下面第 38 行起的那一节是**首轮结算时的状态**（当时没用 .env、没联网，所以标"未完成"）。
> **同一天晚上用户要求跑 e2e，这条验收已达成** —— 原文保留在下面作为过程记录。

| 套件 | 命令（workdir `packages/core`，先导出 `.env`） | 结果 |
|---|---|---|
| E2E core-turn | `& E:\nodejs24\node.exe ..\..\node_modules\vitest\vitest.mjs run tests/memory/e2e/core-turn.test.ts` | **1 passed**（3.5s，真实 DeepSeek + 智谱） |

**停机契约被日志逐条印证**（顺序正确：vector 先、db **最后**卸）：

```
[INFO] [al:vector] 已释放 LanceDB 句柄（停机，尽力而为）
[INFO] [al:db]     已关闭 SQLite 句柄（停机）
```

**验收动作**：`core-turn.test.ts` 的 `afterAll` 已从
「try/catch + EPERM 注释」改为**硬断言** —— `rmSync(...)` 不再吞异常，
并断言 `existsSync(dir) === false`。实测临时目录残留 **0 个**
（`Get-ChildItem $env:TEMP -Filter 'alysia-turn-*'`）。
⇒ 将来谁把停机 effect 弄丢，这一条会**直接红**，而不是像以前那样咽掉异常、留给 OS 清理。

**⚠️ 边界（不许越读）**：这证明的是 **Windows 文件锁已放开到能删除目录**，
**不是**「LanceDB 原生句柄被确定性释放」（后者仍取决于 GC 时机）。
`LanceDBStore.close()` 的注释已按这个口径改写。

### 同一次 e2e 的其他结果（**与停机无关，且已核实不是本 change 造成的**）

`cron.test.ts` / `real-api.test.ts` **各挂 1 条**：
`basics` 没被重写、**facts 一条没提出来**。

**核验过程**：baseline `HEAD` 的 `summaryAnchor()` 与工作区**逐字相同**
（含 `Date.now() - 24h` 兜底）；这两个用例**一行没动**（本 change 只改过
`core-turn.test.ts` 的 afterAll）。

**根因**：`summaryAnchor()` 对「**还没有上一份摘要**」的会话用 `now − 24h` 作下界，
而这两个用例把事件 `created_at` **写死在 `2026-06-28`** ⇒ 比下界早三个多月
⇒ 窗口内 0 条事件 ⇒ `no-events` 直接返回。（对照：`full-session.test.ts` 用
`new Date()`，facts 正常提取、**2/2 通过**。）

⇒ 这暴露的是一个**独立的行为问题**（无历史摘要 + 消息全部早于 24h ⇒ **永不摘要**），
**不在本 change 内修**，需单独立案。

---

## ⚠️ 首轮结算时的"未完成"记录（**已被上面取代**，保留作过程记录）

原需求写着「E2E 的 `afterAll` 去掉 `EPERM` 变通注释（能真删掉临时目录 = 验收）」。
**本次没有做到**，原因是**验证手段不在本会话能力范围内**：

1. 那条验收要跑 `tests/memory/e2e/*`，而它**需要真实 API**（本轮明确不联网、不外传）。
   ⇒ **我没有跑过它**，不能声称「临时目录现在能删掉」。
2. 更要紧的是：**SQLite 与 LanceDB 的释放性质不同**
   - `db.close()` 是**确定性**的 ⇒ `.db` / `-wal` / `-shm` 不再被本进程占住；
   - `LanceDBStore.close()` 只能**放掉包装持有的引用**（napi 绑定没有确定性释放原语）
     ⇒ 目录能否**立刻**删除**取决于 GC 时机**，**未验证**。

因此 `core-turn.test.ts` 的 `afterAll` **保留** try/catch，并已把注释改写为
「**保留是刻意的**：本用例测的是装配，不该因为原生库释放时机判失败；
若将来在 Windows 上确认目录也能删掉，再改成硬断言」。

**这条属于「部分完成」**：代码侧该做的都做了（两个模块都声明了停机 effect），
差的是**在能跑 e2e 的环境里确认目录释放**。如果要继续推进它，
下一步是：在有 `.env` 的环境跑一次 e2e，观察 `rmSync` 是否真的不抛；
若仍抛，则问题在 LanceDB 原生侧，需要在那边找释放手段（可能要给 napi 绑定加 close，
或接受「进程退出后才释放」并把这个结论写进契约）。

## 与 KI-16 的交互（原 proposal 的提醒项）

原提醒写着「与 KI-16 有交互：若读操作会自动写 DB，停机后一次"读"就可能触发一次写入失败」。
**该风险已在同一批次里被消掉**：KI-16 已修（`PersonaStore.get()` 读路径**不再回写默认值**，
见 change `fix-store-write-trace`）⇒ 停机后一次「读」不会再触发写入。**无需额外处理。**

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据。

⚠️ **这是行为变更**，部署后需留意：任何「`core.stop()` 之后仍访问 db」的路径
（server 的停机钩子、外部脚本）会开始**抛错**。目前仓内 74 个 core 用例文件全绿，
`server` 227 全绿，说明**当前没有这样的路径**；但线上若有外部调用方依赖旧行为，会暴露出来。

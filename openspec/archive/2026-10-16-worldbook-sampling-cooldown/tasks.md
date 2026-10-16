# Tasks: worldbook-sampling-cooldown

> backlog 项落地（2026-10-16）。**实测影响面很小**（见下），所以修法取最小、不引入新旋钮。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/worldbook-sample-cooldown.test.ts`
- [x] 复现确认**红**（5 条挂，原文）：
      ```
      × ★★ 主症：刚用过（1 小时前）的条目不得再被采样
        AssertionError: 刚用过的条目又被递给了事件生成器 —— 冷却没生效:
          expected [ '一小时前刚用过的设定' ] to deeply equal []
      × ★★ 条目自己声明的更长冷却同样生效
        AssertionError: 条目声明的 24h 冷却被忽略了:
          expected [ '要求长冷却的设定', '没被用过' ] to not include '要求长冷却的设定'
      × ★ 候选恰好够数时是确定的
        AssertionError: expected [ 'A 刚用过', 'D 长冷却' ] to deeply equal [ 'B 七小时前用过', 'C 从没用过' ]
      × ★★ 与写入侧共用同一个字段：bumpWorldbookHit() 之后立刻采样，该条目必须消失
        AssertionError: bumpWorldbookHit 记了 last_triggered，但采样侧没看它 —— 两个路径没接上
      × ★ 回归：life_event 种子同样受冷却约束
      ```
      ★ 第 3 条最直观：旧实现从 4 条里抽中的**恰好是那两条在冷却期内的**。
- [x] 新增常量 `WORLDBOOK_SAMPLE_COOLDOWN_MS = 6h`（理由写进注释：生成器节奏是小时级）
- [x] `getWorldbookSample()` 两条 SQL **都**加冷却条件
      （`life_event` 与 `text` —— 只改一条是本项最容易犯的错，测试专门锁了）
- [x] 判据 = `max(6h, 条目 cooldown_sec)`（让"共用冷却"成为真的）
- [x] `NULLIF(last_triggered,'')` 兜空串（否则 `julianday('')` 为 NULL ⇒ **永久**排除）
- [x] 更新 `bumpWorldbookHit()` 与 `getWorldbookSample()` 的注释
      （原注释已声称"共用冷却"，现在才成立）

## ⚠️ 实测影响面（如实记，别夸大）

线上（`packages/server/data/alysia.db` 的 `worldbook_entries`）：

| 指标 | 值 |
|---|---|
| 条目总数 | 95（67 text + 15 life_event） |
| content 总量 | 26 KB |
| **`last_triggered` 非空的** | **2 条** |

⇒ 这是**契约缺口**（spec §6 声明了 cooldown 过滤，两条路径里只有一条实现），
**不是正在烧的事故**。所以：不新增旋钮、不改 schema、不做优先级队列 —— 最小修。

## 测试

| 编号 | 场景 | 验收 |
|---|---|---|
| S1 | 1 小时前用过的唯一条目 | 采样为**空**（旧实现会把它抽出来） |
| S2 | 7 小时前用过（`cooldown_sec=300`） | 冷却已过 → 重新可采样 |
| S3 | 从未用过 | 始终可采样 |
| S4 | 条目声明 24h 冷却、7 小时前用过 | **仍排除**（max 语义） |
| S5 | 4 条候选、2 条合格 | 恰好取到那 2 条（确定性） |
| S6 | `bumpWorldbookHit()` 后立刻采样 | 该条目消失（**证明两个路径接上了**） |
| S7 | `life_event` 池的同类条目 | 同样受约束（只改了一条 SQL 会红） |

## 对账方向确认

- [x] spec §6 已声明「cooldown 过滤」⇒ **改 impl，不改 doc**（没把 spec 降级去迁就现状）
- [x] ★ **顺带更正同一句里的另一处陈旧**：§6 原写「**priority 加权**」，
      而 2026-08-27（`life-worldbook-layered-sample`）已刻意改成**分层随机**。
      按「impl 对、doc 旧 → 改 doc」更正，并注明出处。

## Apply 任务

- [x] A.1 合并到 `openspec/specs/ai-life-system/spec.md` §6（采样方式 + 冷却语义表 + 两条路径一致）
- [x] A.2 更新 `openspec/specs/index.md`
- [x] A.3 运行测试（见下）
- [x] A.4 归档
- [x] A.5 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| 定向 | `run tests/memory/worldbook-sample-cooldown.test.ts tests/memory/life-methods.test.ts`（`packages/core`） | **33 passed**（7 新 + 26 既有） |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **79 files / 767 passed**（本 change 前 78 / 760） |
| server 全套 | `npx vitest run`（`packages/server`） | **16 files / 254 passed** |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

## 部署状态

**未部署。** 只改 core 代码与 spec；未构建镜像、未重启服务、未碰线上数据
（排查用的是 `docs`/只读脚本 `scripts/db-query.cjs`）。

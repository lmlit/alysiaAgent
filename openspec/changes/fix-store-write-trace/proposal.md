# Change Proposal: fix-store-write-trace

## 元信息

- **日期**: 2026-10-02
- **类型**: FIX（存储写入可观测性第二刀）
- **状态**: pending（**登记在案**；第一刀与观测已落地，本刀等时机）
- **影响 spec**: `memory-system`（§4.7 存储写入留痕契约）
- **前置**：`fix-migration-and-logger-silent-failure`（第一刀，已落地）、`observe-zero-row-writes`（观测，已落地）

## 这条要解决什么

存储层审计（9 store / 55 写入点）挖出的**其余全部**问题。第一刀只碰了"地基"
（迁移裸 catch + 日志子系统），本刀收拾剩下的。

### 清单（对应 `docs/KNOWN-ISSUES.md`）

| # | 问题 | 危险度 |
|---|---|---|
| **KI-12** | `EventStore.insert` 是 `INSERT OR REPLACE`，**列单不含 `archived`**（而它是 `DEFAULT 0`）→ 同 id 重投（QQ 重连/重试）**静默复活软删除会话、把已摘要事件 `processed` 归 0、清掉 LLM 打的 `importance`** | 🔴 |
| **KI-13** | 知识库「**半截文档 + hash 去重锁死**」：doc 与 chunk **不在一个事务里**，中途失败留下 `status='active'` + `chunk_count` 虚高的壳；重试被 `getByHash` 命中 → 返回**从未兑现的块数**并宣布"已导入 N 块"，**永不自愈** | 🔴 |
| **KI-14** | `LanceDBStore.insert` **永不抛** → 上游所有 `try/catch` 是**死代码**；**2026-09-27 那次事故的同形代码今天仍然活着**（`scripts/backfill-life-importance.ts:118-138` 的 `done++` 计的是"没抛异常"） | 🟠 |
| **KI-15** | `vectorStore` 为 null 时**静默跳过嵌入**（10 条路径）。最危险是 `SessionEndProcessor:160` —— **计数只数摘要、不数向量**，`archived N/M` 照打全绿；删除路径同理 → **孤儿向量继续被召回** | 🟠 |
| **KI-16** | `PersonaStore.get()` 的「**读时回写默认值**」还在：把"人格被冲成空"整形成一组合法默认值（与 seed 逐字相同），**骗过数据层也骗过人工巡检**，且无日志 | 🟠 |
| **KI-17** | `summary_status` 默认 `'ok'`（潜伏）；`updateSummaryResult` 0 行更新仍打「补处理成功」 | 🟡 |
| **KI-5 剩余** | 9 处裸 catch：`CronProcessor:99` / `PromptAssembler:158` / `PersonaStore:33` / `LanceDBStore:59,96,160` / `MemoryManager:188,197,392,418` | 🟠 |

## 为什么是第二刀（为什么不趁第一刀一起做）

第一刀的范围是「**让失败可见**」——迁移与日志子系统。本刀的范围是「**让写入可信**」——
涉及**改判断语义**（`changes` 校验、`insert` 抛不抛、null 降级要不要报、默认值要不要回写 DB），
每一处都会影响调用方控制流，**必须各自验证**，不适合与地基改动混在一个 change 里。

且 `KI-11`（`.changes` 校验）的**口径依赖运行数据** —— 那是 `tune-zero-row-checks` 的活。

## 建议的实施顺序（真要动手时）

1. **KI-14 先做**：`LanceDBStore.insert/delete` 的失败语义（rethrow 还是返回标记）——
   它是**上游一切向量相关容错是否成立**的前提，且改动小、收益大
2. **KI-15 紧跟**：`vectorStore` null 的**逐次**可区分降级（启动那一行 warn 不够），
   尤其把 `SessionEndProcessor:160` 的计数改成**摘要与向量分开数**
3. **KI-16**：兜底与回写分离（读可以给默认值，**不许把默认值写回去**）
4. **KI-12 / KI-13**：结构性改动（改 SQL / 加事务），各自单独验证
5. **KI-5 剩余 9 处**：按第一刀同一手法（能改探测式的改探测式，改不了的至少喊一次）
6. **KI-17**：顺手（默认值改 `'failed'` + 0 行降级）

## 对账方向

- doc 已声明（§4.7）→ **impl 未接完** → **改 impl，不改 doc**。
  **不许把 §4.7 降级来迁就现状。**

## ⚠️ 动手前的提醒

- **别一次全改**：本刀 7 项各自影响控制流，混在一个提交里出问题难定位
- **每项都要有"能复现旧行为"的测试**（尤其 KI-12：同 id 重投必须能构造出来）
- **KI-14 改动会"点亮"一批此前永不触发的 warn** —— 那些是**死代码复活**，属预期，
  但要准备好随之而来的噪声（可在同批里评估是否需要降级为 debug）

# Change Proposal: converge-context-facts

## 元信息

- **日期**: 2026-10-24
- **类型**: MODIFY（结构收敛 + 一处渲染补齐）
- **状态**: **archived**（2026-10-24 归档。全量 158 文件 / 1882 用例通过）
- **影响 spec**: `ai-life-system`（§11 亲密度 —— 补「事实层单一出处」；问候侧同步）
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的 **P8 第 1 + 3 步**
- **前置**: `prove-intimacy-decay-reachable`（已归档）—— 它把 idle 判据修对了，本条把它**收到一处**

## 动机

同一个事实此前**多处各算一遍**，而且其中一处算错（已由上一个 change 修掉）：

| 事实 | 实现 A | 实现 B | 后果 |
|---|---|---|---|
| 多久没说话 | `getLastUserMessageAt()`（全表，无窗口） | 在 `getRecentMessages(…, now−7d)` 里反查 | **窗口 7 天把上限钉死 ⇒ 衰减永不触发**（藏了 2 个月） |
| 亲密度 | `life.ts:relationshipBlock()`：带**档位** + idle | `proactive.contextSnippet()`：只有光秃秃 `62/100` | **问候里看不出"已经冷了几天"** |
| 用户近况 | 组装层 `[关于你的事实]`：去重 + 时间标注 | `getUserActivitySummary()`：facts 前 5 条直出 | 绕过去重与时间标注 |
| 今天的事 | `getLifeEventInjection()` | `listLifeEvents(1)` + 本地日期筛 | 两套筛选口径 |

`eligibility.ts` 头注释把这病命名为「判据被四份代码各答一次」。本条是同一手法，
对象换成**关于此刻的事实**。

## 需求（做什么）

- [x] 新增 `packages/server/src/context-facts.ts`：`ContextFacts` / `FactsSource` /
      `collectContextFacts()` / `idleDaysSince()` / 档位常量与 `intimacyTier()`
      （**纯计算、只读收窄接口、不产出任何面向用户的句子**，纪律照抄 `eligibility.ts`）
- [x] `life.ts`：档位定义搬走并**再导出**（保住既有 import 路径）；
      `idleSinceLastUserMessage()` 改为调 `idleDaysSince()`；`relationshipBlock()` 改为吃 facts
      —— **输出逐字不变**
- [x] `proactive.ts`：`contextSnippet()` 改为吃 facts —— **输出有变**：亲密度带档位与 idle
- [x] **不静默**：读源异常进 `problems[]`（事实层不写日志、不吞），调用方按体裁出声
- [x] `snapshotPresent`：区分「她在这儿、亲密度 30」与「读不到快照、回落 30」——
      否则问候没法判断"这一项算不算素材"（空库不该冒出一句"亲密度 30"）

## 设计决策

**选「事实层在 server，不在 core」**：两个消费者（`life.ts` / `proactive.ts`）都在 server，
放 core 会为了一个 server-only 的结构去动 core 的公共面。等 dsh/console 也需要时再上提。

**选「保留 999 作为显示哨兵」**：`relationshipBlock()` 与档位侧仍用 `null → 999` 表达
「从未说过话」。它**只用于展示与询问判据**，绝不再参与衰减运算（那是旧 bug 的形态），
已在两处注释写明。

**否决「顺便把 assembleChat 的块注册表也切了」**：那是 P8 第 2/4 步，`assembleChat` **不是**
本事实层的消费者（它没有亲密/idle 块）。硬塞会把两个不相干的重构绑在一起。

## 对账方向确认

- [x] **改 impl**：spec §11 早就写着「亲密度注入事件生成器」，但问候侧一直只给裸数字 ⇒ 补实现
- [x] 涉及 Web API？**否**，无新端点（纯内部结构）

## 测试计划

- [x] `context-facts.test.ts`（13 例）：档位边界逐点 / `null` 语义（**不是 7、不是 999**）/
      未来与坏时间戳不产出负数 / 日常按本地日期过滤 / `todayEventLimit=0` 不查库 /
      **读源异常进 problems 不吞**
- [x] `proactive.test.ts`（+2 例）：问候亲密度**带档位与 idle**；刚说过话时不出 idle 那句
- [x] 回归：`life-service` / `life-intimacy-tier` / `proactive` / `life-diary|letter|decline` 全绿
      ⇒ `life.ts` 侧**零行为变更**
- [x] 全量：**158 文件 / 1882 用例**（Node 24）

## 风险

- ⚠️ 问候 prompt 变长了几十个字（档位 + idle 那一句）—— 这是本 change 的目的，且 `proactive.personalize`
  本来就有长度约束（30-60 字文案），不构成预算问题
- ⚠️ `collectContextFacts` 每次做 ≤4 次只读查询；调用节奏是「每小时」或「每条消息」，量级无忧

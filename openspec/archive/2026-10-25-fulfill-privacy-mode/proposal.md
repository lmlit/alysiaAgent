# Change Proposal: fulfill-privacy-mode

## 元信息

- **日期**: 2026-10-25
- **类型**: FIX（spec 承诺未兑现 —— 三处欠账）
- **状态**: **archived**（2026-10-25 归档。全量 162 文件 / 1911 用例通过）
- **影响 spec**: `memory-system`（§4.6 隐私模式）
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的「隐私模式」待办

## 动机：它当初为什么存在

spec §4.6（2026-08-02 引入）原话：

> **问题**: 临时话题/借用设备时，记忆照写照读，无控制开关。

所以它的设计意图是「**这次别把我的资料拿出来**」，不是「别记我」：

| 模式 | 写 EventLog | 读 Profile/Worldbook | 场景 |
|---|:---:|:---:|---|
| `off` | ✅ | ✅ | 正常 |
| `readonly` | ✅ | ❌ | 本次对话**不被长期记忆引用** |
| `full` | ❌ | ❌ | 临时隐身 / 借用设备 |

## 但三处从没实现完整（而且都不报错）

| # | spec 说 | 实际 | 后果 |
|---|---|---|---|
| 1 | 用户发 `//privacy full` 可切 | **全仓没有该命令处理器**（只有 `POST /api/privacy`，console 无 UI） | 一个只存在于 API 的开关 ≈ 不存在 |
| 2 | `readonly` = 本次对话**不被长期记忆引用** | 只做了当次不注入；`ingest` 照写、画像照提取 | 这段对话**会**在下次正常对话里被注入 —— **承诺没兑现** |
| 3 | 会话结束恢复 `off` | `onSessionEnd` 里**内联**赋值，`resetPrivacyMode()` 是**只有测试在调用的死代码**；且**任何**会话结束都清 | 多会话时，别人一句 `/new` 就把你刚开的隐私清了 |

★ 顺带更正我自己的两处误判（写下来防复发）：
- 我说过「readonly 名字与行为不符、像假开关」—— **偏了**。spec 表格明确写着 `readonly` 仍写入，
  它从没承诺"不记"。真正的洞是第 2 条那半句「不被长期**引用**」。
- 我说过「reset 完全没接线」—— **也不准**。行为是实现的，只是内联；死的是那个命名方法。

## 需求（做什么）

- [x] **`readonly` 兑现**：`ingest()` 在 readonly 时给 payload 打 **`skip_profile`**
      （复用 `eligibility` 那套现成判据：不进画像 / 不进人格 / 不生成嵌入 ⇒ 不会被召回）。
      事件**仍进 EventLog**（可审计/可复盘），但**不参与学习**
- [x] **入口**：新增 `createPrivacyCommand()` → `/privacy off|readonly|full`（别名 `/p`），
      在 `al:commands` 注册。无参数报当前模式 + 用法；非法值**明说没变**；切换后回执**说清这个模式做了什么**
      （"仍会存档"这句必须有 —— 否则用户以为全隐身）
- [x] **reset 收口**：`resetPrivacyMode(sessionId?)` 成为唯一实现（`onSessionEnd` 改调它），
      并引入 `privacySessionId`：**由哪个会话开启的，只在该会话结束时恢复**；
      API 全局开启（无 sessionId）则任何会话结束都恢复。恢复**留痕**、返回布尔（不假装做了事）
- [x] spec §4.6 重写三处 + 加两条对账须知

## 设计决策

**复用 `skip_profile` 而不是新造一个"隐私不学习"开关**：`eligibility.ts` 已经是「能不能学」的
唯一判据（来源 × 用途矩阵），隐私模式只是**另一个决定来源**。为它另写一套判定 = 造第五份判据，
正是这个项目一直在治的病。

**`readonly` 保留"仍入库"**：这是原设计有意区分的两档 ——
`readonly` = 存档但不引用（可审计），`full` = 连存档都不写（真隐身）。删除这个区别会让 `full` 失去意义。

**`privacySessionId` 只在"命令开启"时记录**：`POST /api/privacy` 没有会话概念，
所以那种开启视为全局 —— 任何会话结束都恢复（与该 API 的语义一致，且不会永远卡在非 off）。

## 对账方向确认

- [x] **改 impl 不改 doc 的语义**：spec §4.6 的三条承诺本身是对的（是设计意图），
      impl 补齐即可；§4.6 只做**澄清与历史记录**，不降级
- [x] 涉及 Web API？`POST /api/privacy` **签名不变**（`setPrivacyMode` 多了一个可选 `sessionId`），
      `docs/Web-API-Design.md` 无需改；**新入口是命令，不是端点**

## 测试计划

`packages/core/tests/memory/unit/privacy-mode.test.ts`（11 例）：

- off → 照写、**不打** `skip_profile`
- ★ readonly → **入库存档**但打 `skip_profile`（这就是"不被长期引用"的实现）
- full → 连存档都不写
- ★ 恢复 off 后新消息不再带标记（模式是"当次"的）
- ★ **别的会话结束不该清掉本会话开的隐私**（原实现会）
- API 全局开启 → 任何会话结束都恢复
- 已是 off 时 reset 返回 false（不假装做了事）
- `/privacy`：无参报状态 / 切换回执说清做了什么 / 非法值明说没变 / sessionId 透传

全量：**162 文件 / 1911 用例**。

## 未做（明确边界）

- ❌ **console UI**：仍然只有命令 + API。要不要做界面是产品决定（不属于"兑现承诺"）
- ❌ 不改 `assembleMinimal`（当次不注入的行为本来就是对的）
- ❌ 不动 `//privacy` 双斜杠写法 —— 那个注册表按 `slice(1)` 解析，双斜杠永远匹配不到；
      spec 已更正为单斜杠

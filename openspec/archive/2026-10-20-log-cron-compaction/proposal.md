# Change Proposal: log-cron-compaction

## 元信息

- **日期**: 2026-10-20
- **类型**: OBSERVABILITY + DOC（**零行为变更**，只加日志与契约）
- **状态**: `applied`
- **影响 spec**: `memory-system` **§4.1.6（新增）**；`docs/KNOWN-ISSUES.md` **KI-27（新登记）**

## 这条要解决什么

`CronProcessor.compactOldEvents()` **一行日志都没有**：把 >7 天仍未处理的事件标成
`processed = ALL_FLAGS`，而"清了 300 条"与"一条都没有"在日志上完全同形。

## ★ 查证时纠正了一个我自己的错误判断

我先前说这是"**静默放弃学习**"，据此还写过一段很重的论证。**那是错的。**

核实结果：

| 环节 | 按 `processed` 过滤吗 | 依据 |
|---|---|---|
| 会话摘要 | ❌ **不筛** | 走 `getBySession`；`summaryAnchor` 注释明写「窗口锚点是唯一的闸」 |
| 画像提取 | ❌ 不筛 | 由会话结算经 `getBySession` 驱动 |
| 人格扫描 | ❌ 只**写**位，从不读 | `RealtimeProcessor` |

而 `getUnprocessed`（读 processed 的唯一地方）**唯一调用者就是 compaction 自己**。

⇒ **compaction 的真实效果是"清空 `getUnprocessed` 的积压"**（语义卫生），
**不是**"放弃学习"。两者差别很大：前者不损失任何学习，后者会。

## 需求

1. 计并打日志：条数 + 最老天数 + **明写"不影响摘要/画像"**
2. >500 条时额外 `warn`（通常意味着有一段时间没跑结算）
3. 0 条时用 `debug`（不刷屏）
4. 把真实语义写进代码注释 + `memory-system` §4.1.6
5. **登记 KI-27**：`processed` 位掩码只写不读（"已处理"没有消费者）

## 为什么登记 KI-27 而不是直接删

`processed` 有两种未来：**赋予语义**（各处理器按位判重）或**删掉一半**。
这需要动 `SessionEndProcessor` / `RealtimeProcessor` / 回填路径，属独立决策。
本 change 只做"让它不再假装在工作"（日志 + 契约 + 债目登记），删/赋语义留给独立 change。

## 不做什么

- 不改 compaction 的行为（阈值 7 天、ALL_FLAGS 都不动）
- 不删 `processed` / `getUnprocessed`
- 不动 `getBySession` 的过滤语义（它是摘要正确性的地基）

## 测试（5 条）

- 有积压 ⇒ info 含条数与最老天数，且含 `getBySession`（证明写明真实语义）
- ★ **真实语义**：被标记的事件**仍进得了摘要窗口**（这条是防我再次误判的锚）
- 无积压 ⇒ 不打 info
- >500 ⇒ 额外 warn
- 已 processed 的不重复计入

## 回滚

纯日志 + 文档，回滚 = 删掉那几行 `logger.*`。

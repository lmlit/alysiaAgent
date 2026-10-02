# Change Proposal: decide-life-event-max-tokens

## 元信息

- **日期**: 2026-10-02
- **类型**: FIX（按观测数据决定采样槽预算）
- **状态**: pending（**登记在案，等运行数据**——观测已上线，数据还没攒）
- **影响 spec**: `memory-system`（§4.1.2 推理预算观测契约 → 补判定结论）
- **前置**：`add-llm-budget-observability`（**已落地**，负责把证据采得到）

## 这条要解决什么

`docs/KNOWN-ISSUES.md` **KI-1**：`life.generateEvent` 槽**没有 `max_tokens`**（走服务端默认值，
一个未知量）。而 `CHAT_MODEL` 是推理模型、reasoning 与可见内容**共用同一预算** ——
这个机制**已造成三次线上事故**（会话摘要 22 天 100% 失败 / 每日反思 11 次空响应 /
画像提取静默停摆 6 个月）。

KI-1 与它们**同形**：要输出多字段 JSON（`content` 2-4 句 + `message` + `agency` + `intent` +
`next_in_hours`…），且项目 8-27 / 8-28 两次主动把事件**越写越长**。

**为什么之前没修**：不是"没发生"，是**证据拿不到**。`observe-*` 之前，
`finish_reason` / `reasoning_tokens` **从未被解析**，所以连"预算有没有被吃光"都判不了。
**现在采得到了。**

## 需求（做什么）

- [ ] **采数据**（等运行量；或按 `scripts/verify-session-summary-fix.ts` 的方法论写探针打一次）
- [ ] 读 `[Life] event LLM: finish=… tokens=… reasoning=… content=N字` 这一行
- [ ] 按判定口径下结论：

| 观测 | 含义 | 动作 |
|---|---|---|
| `finish=length` + `content=0字` | **预算被推理吃光** | 给该槽显式 `max_tokens`（**附实测数字**） |
| `finish=stop` 且数字宽裕 | 不是预算问题 | 在 §4.1.2 记一句「**已实测安全**」闭环 |
| 偶发 `finish=length` | 临界 | 给出留有余量的值 + 说明依据 |

- [ ] **顺带闭环 KI-2**：看 `proactive.personalize`（256）与 `vision.describe`（200）两行的数字
      —— provider 层 `[LLM]` 日志对**所有槽位**都输出 `finish=` / `reasoning=`，
      无需额外打点，看到即可判定

## ★ 纪律（本条最重要，不是形式）

**没有观测就不许改预算数字。**

这个项目在"拍脑袋定预算"上吃够了亏 —— §4.1.1 记录的那三次事故，
成因全是「预算给小了但没人知道」。所以本 change 的**第一个交付物是数据，不是代码**。

**若数据显示安全**：那就**不改代码**，只把"已实测安全"写进 spec 闭环 ——
**这也是一个有效结论**，不是白干。

## 对账方向

- §4.1.2 已声明判定口径 → 本 change 是**执行它** → **改 impl（或补结论），不改 doc**。

## ⚠️ 提醒

- 采数据会**花真钱**（几毛钱级别），但比事后追一个静默故障便宜
- **别只看单次**：推理 token 占用随 context 长度波动（事件生成会注入近 24h 事件 + 世界书采样 +
  最近对话），**要覆盖"上下文最长"的那种轮次**才有意义
- 改完记得：**单测抓不到这个**（LLM 是 mock 的）→ 必须跑真实 API 验证（HANDOFF 约定 6）

# 待办总表（导航层，不是正文）

> 建立于 2026-10-18。**定位：唯一能回答"现在还剩什么没做"的入口。**
>
> 存在的理由：待办散在三处 —— `docs/KNOWN-ISSUES.md`（64KB，26 条 KI）、
> `openspec/specs/index.md` 的 📌 Backlog（一张大表，单元格里塞整段论证）、
> `openspec/changes/**`（11 个）。**没有一处能一眼看完在办清单**，
> 结果就是"修好的条目继续躺在待办里、未修的条目被当成已修"
> （2026-10-18 本次整理时，我自己就把已修的 KI-14/15/21 读成了未修）。

## 规则（防止本表退化成第四个影子文档）

1. **只做导航**：每条一行，正文永远在原处。这里**不写**现象/证据/论证。
2. **不新建编号**：沿用既有 ID（`KI-xx` / change 名），避免两套 ID 漂移。
3. **权威顺序**：`openspec/changes/<name>/proposal.md` > `docs/KNOWN-ISSUES.md` > spec 的 Backlog。
4. **新增待办**：先落原处（KI 登记册或开 change），**再回本表加一行**。
5. **销账**：改原处 + 删本表这一行。顺序反过来必然漏。

## 图例（"卡在谁"）

| 标记 | 含义 |
|---|---|
| 🧑 | 需要你拍板 / 你手上才有数据 |
| 🤖 | 我可以直接做，无需额外输入 |
| ⏳ | 等运行数据，**没数据不许动**（本项目纪律） |
| ⏸ | 明确决定暂不做 |

---

## A. 静默失败族（6 条，根因见 [SILENT-FAILURE.md](SILENT-FAILURE.md)）

> 其中 **3 条已收进 change [`harden-silent-failures`](../openspec/changes/harden-silent-failures/proposal.md)**
> （2026-10-18 新开，**不含** KI-11 / KI-1 / KI-2 —— 它们各自有 change 在等数据）。

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| KI-5 | 裸 `catch {}` 存储层已清，**其余 4 处未清** | 🤖 已立项 | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-25 | dsh 去重键取 `event.seq`，`seq` 跨重启是否重数**未证实** | ⏳ 已立项（只取证，不换键） | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-26 | 「无历史摘要 + 消息全早于 24h」⇒ 那批消息**永不进摘要** | 🤖 已立项 | [harden-silent-failures](../openspec/changes/harden-silent-failures/proposal.md) |
| KI-11 | 52/55 写入点无 `.changes` 判据（观测已上线） | ⏳ 等 `[WriteTrace]` 分布 | [tune-zero-row-checks](../openspec/changes/tune-zero-row-checks/proposal.md) |
| KI-1 | `life.generateEvent` 无 `max_tokens` | ⏳ 等 `[LLM]` 数据 | [decide-life-event-max-tokens](../openspec/changes/decide-life-event-max-tokens/proposal.md) |
| KI-2 | `proactive.personalize: 256` / `vision.describe: 200` 未校准 | ⏳ 同上（并入同一 change） | 同上 |

## B. 契约 / 边界缺陷（**无 change**，可直接立项）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| KI-3 | 两个 `ILLMService` 实现无一致性契约测试 | 🤖 | [KNOWN-ISSUES #KI-3](KNOWN-ISSUES.md#L86) |
| KI-7 | `/stop` 只打日志，不做中断 | 🤖 | [KNOWN-ISSUES #KI-7](KNOWN-ISSUES.md#L375) |
| KI-8 | 根目录 `config.yml` 是死文件（与 `packages/server/config.yml` 双份漂移） | 🤖 | [KNOWN-ISSUES #KI-8](KNOWN-ISSUES.md#L384) |
| KI-9 | `memory/services/` 半死代码（仅测试在用） | 🤖 | [KNOWN-ISSUES #KI-9](KNOWN-ISSUES.md#L403) |
| KI-10 | 内核缺「只排序、不依赖服务」的表达（`after?`） | 🤖 | [KNOWN-ISSUES #KI-10](KNOWN-ISSUES.md#L392) |
| KI-18 | `/api/sessions/:id/extract` 无任何校验 | 🤖 | [KNOWN-ISSUES #KI-18](KNOWN-ISSUES.md#L414) |
| **新增 2026-10-19** | **向量检索静默退化成文本检索**：容器日志 `[WARN] [Memory] vector search failed, fallback to text search: Embed API error 400`（01:20 起多次）。召回质量在降，但**没人会发现** —— 正是静默失败族的样子 | 🧑 | 日志（`/app/data/logs/alysia-2026-10-19.log`）；根因待查（智谱 embedding 请求体/额度？） |

## C. 能力机会（不是缺陷，是"要不要做"）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| retire-glm-vision-bridge | DeepSeek 原生可看图，GLM 那层技术上冗余（但记忆是纯文本的） | 🧑 决策 | [proposal](../openspec/changes/retire-glm-vision-bridge/proposal.md) |
| improve-sticker-selection | 表情包无权重/无冷却/无管理入口 | 🧑 先定三件事 | [proposal](../openspec/changes/improve-sticker-selection/proposal.md) |
| tune-recall-with-runtime-data | 召回系数是拍脑袋的，该由运行数据定 | ⏳ 先补观测 | [proposal](../openspec/changes/tune-recall-with-runtime-data/proposal.md) |
| add-ops-health-report | 缺**正确性**指标（摘要 22 天全灭时 healthcheck 全绿） | 🧑 原话"日报算了" | [proposal](../openspec/changes/add-ops-health-report/proposal.md) |
| console-a11y-motion | console 17 处持续动画无 `prefers-reduced-motion` | ⏸ 先记着 | [proposal](../openspec/changes/console-a11y-motion/proposal.md) |
| build-alysia-console-plugin | dsh 侧控制台插件：4 个面板页 + 真机验收 | 🤖 | [proposal](../openspec/changes/build-alysia-console-plugin/proposal.md) |
| add-approval-gate | 审批闸（2026-10-18 新开） | 🤖 | [proposal](../openspec/changes/add-approval-gate/proposal.md) |
| record-out-of-band-server-config-change | 记录一次带外服务器配置变更 | 🧑 | [proposal](../openspec/changes/record-out-of-band-server-config-change/proposal.md) |
| ~~阶段白名单没收她的产物~~ ✅ | **2026-10-18 已修**（`scope-loop-to-this-round`）：写权限分层（只有 `public/**` 是权限边界）+ 判据按本轮 `mtime` 过滤；`.tmp/` 不进快照 | ✅ 已上线 | [spec §17 契约 68b/68c](../openspec/specs/project-tasks/spec.md) |
| ~~build 类重阶段 30 分钟超时~~ ✅ | **2026-10-18 已修**（同一 change）：按阶段给超时（build 5400s）+ 超时杀进程组 | ✅ 已上线 | [spec §17 契约 68d](../openspec/specs/project-tasks/spec.md) |

## D. 部署 / 数据债（代码已好，线上还是旧的）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| fix-reflection-insight-misroute | **已归档但未部署** ⇒ 线上每日反思仍会把 `insight` 错写进用户画像 | 🧑 发版会连带 console 改动 | [proposal](../openspec/archive/2026-10-15-fix-reflection-insight-misroute/proposal.md) |
| 历史画像回填 | 线上 `basics`/`facts` 长期稀疏，修复只保证从此往后 | 🧑 需连服务器 | [specs/index.md](../openspec/specs/index.md) |

## E. 暂停 / 不做

| 条目 | 一句话 | 决定 |
|---|---|---|
| 中途插话 / 暂停 | `continue_project_task` 在 `running` 时拒收意见，没有暂停接口 | ⏸ 2026-10-18 你明确"暂不设计" |
| webui-visual-redesign | 对象（Vue 版 `packages/webui`）已删 | 🗑 superseded，不再推进 |

## F. 已销账（**不在此重复正文**）

26 条 KI 中 **14 条已修**：KI-4 / 6 / 12 / 13 / 14 / 15 / 16 / 17 / 19 / 20 / 21 / 22 / 23 / 24。
证据与契约审计在 [KNOWN-ISSUES](KNOWN-ISSUES.md) 各自小节（带 ★ 与 change 链接）。
本表不列它们，只留这一行计数 —— **下次整理时核这个数字**：`26 - 14 = 12 条在办`。

---

## 维护提示

- 本表长度应**长期保持在 30 行量级**。超过 45 行说明在办的事太多了，不是在办的事太细。
- 每条被删掉时，在 commit message 里写清销账依据（`KI-xx → change xxx 已归档`），
  否则三个月后没人知道那行为什么消失。

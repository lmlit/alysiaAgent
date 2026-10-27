# 待办总表（导航层，不是正文）

> 建立于 2026-10-18；**2026-10-26 重写**（change: `reconcile-stale-todos`）。
> **定位：唯一能回答"现在还剩什么没做"的入口。**
>
> 重写的理由：原表停在 10-25 11:36，之后 6 个归档没进表，表里还挂着已修/已部署的条目
> （KI-26、`fix-reflection`、P6、P7）——**待办表本身在产假话**，下一轮必然把已修的读成未修。

## 规则（防止本表退化成影子文档）

1. **只做导航**：每条一行，正文永远在原处（KI 册 / change / spec / archive）。
2. **不新建编号**：沿用 `KI-xx` / change 名 / `Pxx`。
3. **权威顺序**：`openspec/changes/<name>/proposal.md` > `docs/KNOWN-ISSUES.md` > spec 的 Backlog。
4. **新增待办**：先落原处，**再回本表加一行**。
5. **销账**：改原处 + 删本表这一行 + 在 F 段记一行（日期 + 依据）。

## 图例（"卡在谁"）

| 标记 | 含义 |
|---|---|
| 🧑 | 需要你拍板 / 你手上才有数据 |
| 🤖 | 我可以直接做，无需额外输入 |
| ⏳ | 等运行数据，**没数据不许动** |
| ⏸ | 明确决定暂不做 |

---

## A. 静默失败族（4 条在办）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| **KI-25** | dsh 去重键取 `event.seq`，`seq` 跨重启是否重数**未证实**；⚠️ `bridge:false` 后 ingest 已关，触发路径**休眠** —— 重开写通道前必须先取证 | ⏳ 等重开前取证 | [KNOWN-ISSUES #KI-25](KNOWN-ISSUES.md#L791) |
| **KI-11** | 55 个写入点仅 3 处检查 `.changes`；`[WriteTrace]` 已上线 | ⏳ 等 `[WriteTrace]` 分布 | [tune-zero-row-checks](../openspec/changes/tune-zero-row-checks/proposal.md) |
| **KI-1** | `life.generateEvent` 无 `max_tokens`，与爆过三次的槽同形 | ⏳ 等 `[LLM]` / `[Life] event LLM` 数据 | [decide-life-event-max-tokens](../openspec/changes/decide-life-event-max-tokens/proposal.md) |
| **KI-2** | `proactive.personalize: 256` / `vision.describe: 200` 未校准（并入 KI-1） | ⏳ 同上 | 同上 |

> ✅ KI-5（裸 catch）与 KI-26（摘要锚点）已于 2026-10-26 / 10-16 修完，见 F 段。

## B. 契约 / 边界（**无 change，可直接立项**）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| **组装器第 4 步 `genres`**（P8） | 8 条生成链路的预算/采样/persona 节数/forbids 还在函数体里；前三步已归档 | 🤖 1–2 天，行为会变（要快照） | [PLAN §2.6](PLAN-2026-10-24-context-and-rules.md#L149) |
| **KI-10** | 内核缺「只排序、不依赖服务」的表达（`after?`）；只有 1 处，结论是暂不加 | ⏸ 记着待观察 | [KNOWN-ISSUES #KI-10](KNOWN-ISSUES.md#L420) |

> ✅ P9（`pipelineMode` 标死）、KI-27（位掩码退役）、P4（删 `alysia_life`）、
> P5（写清设计意图）已按 2026-10-26 决定处理，见 F 段。

## C. 能力机会（不是缺陷，是"要不要做"）

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| `build-alysia-console-plugin` | 面板 1/2 已做；剩 3 个面板 + `install_bundle` 真机验收 + A.3–A.5 | ⏸ **2026-10-26 冻结**（dsh 已降权） | [tasks](../openspec/changes/build-alysia-console-plugin/tasks.md) |
| `add-approval-gate` | 设计完整（answerer + 待批表 + QQ 提问 + 会话早检 + `needs_approval`），**一条没实现** | ⏸ **2026-10-26 缓**：等委托任务真的跑危险动作 | [proposal](../openspec/changes/add-approval-gate/proposal.md) |
| `retire-glm-vision-bridge` | DeepSeek 原生能看图，GLM 层冗余；但 GLM 免费、记忆是纯文本 | ⏸ 保持现状（你说"先不改，记一下"） | [proposal](../openspec/changes/retire-glm-vision-bridge/proposal.md) |
| `improve-sticker-selection` | 无权重/冷却/管理入口；动手前先定三件事（场景分组 / 启停位置 / 冷却作用域） | ⏸ **2026-10-26 先不做**（三件事未定） | [proposal](../openspec/changes/improve-sticker-selection/proposal.md) |
| `tune-recall-with-runtime-data` | 召回系数是拍的；`[Recall]` 观测已有 | ⏳ 等真实分布 | [proposal](../openspec/changes/tune-recall-with-runtime-data/proposal.md) |
| `add-ops-health-report` | 缺正确性指标（22 天摘要全灭时 health 全绿）；前置是日志源头分级/限频 | ⏸ **2026-10-26 不做**（要做先清日志源） | [proposal](../openspec/changes/add-ops-health-report/proposal.md) |
| `record-out-of-band-server-config-change` | 两个预算已进默认值；剩 `life.generateSummary`/`deepRewrite` 校准 + 完整服务器 diff | ⏳ 等数据 / 🧑 需 host | [proposal](../openspec/changes/record-out-of-band-server-config-change/proposal.md) |
| 唤醒派发多实例租约 | 派发是单实例进程内的；开第二个实例会重复领队列 | ⏳ 等多实例需求 | [project-tasks §18](../openspec/specs/project-tasks/spec.md) |

## D. 部署 / 数据债

| 条目 | 一句话 | 卡在 | 权威出处 |
|---|---|---|---|
| **历史画像回填** | **2026-10-27 线上只读细分**：`pending 330` 实为 **12 个 session 的窗口**（313 个来自同一个 QQ 私聊），其中 **315/330 所属 session 已有 facts**（`facts_attempts` 全 0）⇒ 是**状态滞后，不是学习缺口**。`84 个未结算` 中 **69 个是委托/合成会话**（388 事件，按设计不学），**真正该结算的只有 15 个 session / 415 事件**（13 dsh + 2 QQ，7-26～10-02） | 🧑 是否补这 15 个（dsh 写通道已切；建议至多补 2 个 QQ）；重放未做 | [KNOWN-ISSUES](KNOWN-ISSUES.md#L914) |
| **31 条 `needs_review`** | 10-19 存量（24 条卡 `intent`，18 条结果 ≤80 字）；不阻塞、watchdog 不报 | ⏸ **2026-10-26 不动** | [验收记录 §4](ACCEPTANCE-2026-10-19-WAKE.md) |

## E. 暂停 / 不做

| 条目 | 一句话 | 决定 |
|---|---|---|
| 中途插话 / 暂停 | `continue_project_task` 在 `running` 时拒收意见，也没有暂停接口 | ⏸ 2026-10-18 你明确"暂不设计" |
| `webui-visual-redesign` | 对象（Vue 版 `packages/webui`）已删 | 🗑 superseded，不再推进 |
| Halo 主题（`packages/halo-theme-xilian`） | 独立试验，只在本地 Halo 验过；**用户 2026-10-26 明确"先别搞"** | ⏸ 不占本表 |

## F. 最近销账（2026-10-24 ～ 10-26）

> 26 条 KI 中 **21 条已修**，在办 5 条（KI-1 / 2 / 10 / 11 / 25）；
> 另有 KI-27 已于 2026-10-26 销账。证据在各 archive 的 proposal / tasks。

| 日期 | 条目 | 依据 |
|---|---|---|
| 10-26 | **预算默认值**：personalize 256→1024、session.summary 2048→4096 | [`apply-decisions-2026-10-26`](../openspec/archive/2026-10-26-apply-decisions-2026-10-26/proposal.md) |
| 10-26 | **KI-27** `processed` 位掩码退役（含 compaction） | 同上 |
| 10-26 | **P4** 删 `{{alysia_life}}` 空变量；**P5** 写清生活 context 不含画像 | 同上 |
| 10-26 | **P9** `pipelineMode` 标死（保留 `assembleCode`，文档改为仅 API/测试可达） | 同上 |
| 10-26 | **console a11y** 17 处动画加 `prefers-reduced-motion` | 同上 |
| 10-26 | **看门狗**加“正挡着活就说一声” | 同上 |
| 10-26 | 本机 498.2MB 部署杂物已删 | 同上 |
| 10-27 | **已发版**：`rollback-20261027-083150`，health 200 / Bot ONLINE；容器内预算已核对 | [apply-decisions tasks](../openspec/archive/2026-10-26-apply-decisions-2026-10-26/tasks.md) |
| 10-27 | **构建上下文瘦身**（曾卡 7 小时）：`.dockerignore` 排掉素材/实验目录 | [`slim-docker-build-context`](../openspec/archive/2026-10-27-slim-docker-build-context/proposal.md) |
| 10-26 | **KI-5** 最后 2 处裸 catch（QQ 适配器）+ `check-bare-catch` 机器闸 | [`harden-silent-failures`](../openspec/archive/2026-10-26-harden-silent-failures/proposal.md) |
| 10-26 | **KI-26** 摘要锚点（早已修，本次销账） | [`fix-summary-anchor-floor`](../openspec/archive/2026-10-16-fix-summary-anchor-floor/proposal.md) |
| 10-26 | **P6** 表态时钟 / 值得说 | [`worth-telling-and-silence-clock`](../openspec/archive/2026-10-25-worth-telling-and-silence-clock/proposal.md) |
| 10-26 | **P7** 记忆资格收口（代码在 HEAD，只剩合 master） | [`unify-memory-eligibility`](../openspec/archive/2026-10-21-unify-memory-eligibility/proposal.md) |
| 10-26 | `fix-reflection-insight-misroute`（已部署，10-25 镜像含修复） | [`archive`](../openspec/archive/2026-10-15-fix-reflection-insight-misroute/proposal.md) |
| 10-25 | 她的记录合并成一张表 + 秘密日记 + 反思回读 + 只读出口 | [`her-records-one-table`](../openspec/archive/2026-10-25-her-records-one-table/proposal.md) |
| 10-25 | 关停页面/博客发布能力（`features.publish` 默认 false） | [`disable-publishing`](../openspec/archive/2026-10-25-disable-publishing/proposal.md) |
| 10-25 | 回滚点自动保留最近 3 个（生产 37→4 镜像） | [`prune-old-rollback-images`](../openspec/archive/2026-10-25-prune-old-rollback-images/proposal.md) |
| 10-25 | 隐私模式三档兑现 / 两段式转述 / 语气配额回退 | `fulfill-privacy-mode` / `retell-events-in-her-voice` / `revert-speech-quota` |

---

## 维护提示

- 本表长度应**长期保持在 30 行量级**（当前在办约 25 行）。超过 45 行说明在办的事太多。
- 每条被删掉时，在 commit message 里写清销账依据（`KI-xx → archive xxx`）。

# Alysia Agent — OpenSpec 治理宪法

> 本文档是 alysia 项目开发流程的 **source of truth**。所有开发行为（含 AI 代理）必须遵守。
> 来源：2026-08-07 治理迁移。取代 superpowers 时间点 spec 体系（旧文档已迁移归档，见 [specs/index.md](specs/index.md)）。

## 为什么用 OpenSpec（背景）

旧 superpowers 体系（`docs/superpowers/specs/`）本质是 **write-once 时间点设计文档**：

- 主 spec 不随实现更新 → spec 与代码持续分叉（drift），且无机制逼回对账
- 无 archive 合并回主库 → 版本演进只靠文件内改版本号，旧意图丢失

OpenSpec 补上这个 loop：**spec 是活的**，每个 change 走 `propose → apply → archive`，
apply 时把变更合并回主 spec，archive 留下审计记录。spec 当 source of truth——**事前驱动而非事后追认**。

## 目录结构

```
openspec/
├── project.md          # 本文档（治理宪法）
├── specs/              # ★ 活的 spec（source of truth）
│   └── <slug>/spec.md  # 每个子系统一份，随实现持续更新
│   └── index.md        # 索引 + 状态
├── changes/            # 进行中的 change（propose 后、archive 前）
│   └── <change-name>/
│       ├── proposal.md # 动机 + 需求 + 设计
│       ├── tasks.md    # 任务清单
│       └── spec.md     # 变更后的完整 spec（含 diff 标记）
├── archive/            # 已归档 change + 旧 spec 版本 + 迁移的 legacy 文档
└── templates/          # change 骨架模板
```

## 开发流程：每个 change 必走 loop

> **纪律：任何行为变更（新功能、改行为、修 bug）必须走 OpenSpec loop，禁止直改不 archive。**

1. **propose**：`openspec/changes/<change-name>/` 建骨架（proposal.md + tasks.md + spec.md）。
   写明动机、需求、设计决策。spec.md 给出变更后的完整 spec（变更行用 diff 标记）。
   - 可以先用技能 `/openspec-change` 生成骨架
2. **apply**：实现代码。每完成 tasks.md 一项勾一项。实现完成后把变更合并回 `openspec/specs/<slug>/spec.md`。
3. **archive**：`/openspec-archive` 把 change 移入 `openspec/archive/<date>-<change-name>/`，
   索引更新状态。变更记录永久可查。

纯文档类修改（只改 spec 不碰代码）也走同流程，change 里 tasks.md 标"纯文档"。

## 对账规则：gap 方向判断（防设计意图被抹掉）

spec 与实现出现不一致时，**先判方向，再动手**：

| gap 类型 | 方向 | 动作 |
|----------|------|------|
| impl 是对的、doc 旧了 | impl → docs（backfill） | **改 doc**。这是 ratify drift，必要但是"输的方向" |
| doc 已声明、impl 没接 | docs → impl | **改 impl，不是改 doc！** 把 spec 降级迁就现状 = 设计意图被永久抹掉，gap 隐形 |

拿不准时默认**留 doc**，先问"这个设计意图还要不要"；不要图省事改 doc 了事。

## 待办/搁置的处理

- 明确列入二期的功能 → 写在对应 spec 的"二期/后续"节，不动主文
- 已声明但未实现、且暂时不做 → **开 change 记录在案**（`openspec/changes/<name>/proposal.md` 标记 `status: pending`），让 gap 可见、可恢复，不许悄悄删
- 搁置的思路 → spec 里保留一节"搁置（思路留存）"或归档入 archive

## 执行工具（可选复用）

- spec 生命周期由 OpenSpec 流程管；执行层可继续用 superpowers skills
  （subagent-driven-development / TDD / 代码评审），两者互补不冲突：
  - **OpenSpec** 管"做什么、为什么、改了什么"（spec 生命周期）
  - **superpowers** 管"怎么执行"（任务拆分、评审、验证）
- 运行时日志、git 提交等约束见项目根 CLAUDE.md

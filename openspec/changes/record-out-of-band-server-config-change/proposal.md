# Change Proposal: record-out-of-band-server-config-change

## 元信息

- **日期**: 2026-10-17
- **类型**: DOC（纯文档 / 对账）
- **状态**: **pending**（已在案，尚未实施；按 `openspec/project.md` 的「已声明但暂时不做」登记）
- **影响 spec**: `memory-system`（§4.1.1 推理预算）
- **发现方式**：只读盘点服务器时读到 `/root/alysia-ops/CHANGELOG.md`

## 动机（为什么做）

服务器上的生产配置 `/root/alysia/config.yml` 在 **2026-10-16** 被改动过
（操作人写的是「运维 agent（受用户指令）」），而这次改动：

- **没有走 OpenSpec**（本仓治理要求行为变更先立项）；
- **在仓库之外**——本仓的 `config.example.yml` / `sampling` 默认值里**看不到它**。

⇒ 形成一处典型的 **impl/doc 分叉**：读过仓库的人会以为线上跑的是仓库里的默认值。
按 `openspec/project.md` 的对账规则，这属于「impl 已经变了、doc 没有」→ **应当 ratify（改 doc）**，
但需要先判定**方向**：这两个值该进仓库默认值，还是该作为「部署侧覆盖」被记录？

## 事实（来自 CHANGELOG，非本次实测）

| # | 槽位 | 字段 | 旧值 | 新值 | 依据 |
|---|---|---|---|---|---|
| A | `sampling.proactive.personalize` | `max_tokens` | 256（core 默认） | **1024** | 实测 reasoning 吃满 256 → `finish=length` + 空内容 → **主动问候发出空消息**（用户可见） |
| B | `sampling.session.summary` | `max_tokens` | 2048（core 默认） | **4096** | 实测 reasoning 1912–1973 独占 2048，JSON 被截断（重试才成功） |

同时把这两个槽位**从注释状态解除注释**（原文件里全部槽位都是注释掉的，走 core 默认值）。

- 备份：`/root/alysia/config.yml.bak-20261016-150436`；回滚命令写在 CHANGELOG 里。
- 重启验收：容器 healthy、容器内两个值已生效、QQ `Bot ONLINE — READY`、启动 ERROR 0 条。
- **未改动**：`chat` / `vision.describe` / `life.*` / `profile.*` 全部保持注释（走 core 默认）。
- **遗留观察项**（CHANGELOG 自记）：`life.generateSummary` 与 `profile.deepRewrite`（都默认 2048）
  与历史事故同源，**本次未动**——与 `docs/KNOWN-ISSUES.md` 的 KI-1/KI-2 是同一族。

## 需求（做什么）

- [ ] 判定方向：这两个值**进仓库默认值**（`packages/core/src/provider/sampling.ts`）
      还是**作为部署覆盖记录**（写进 `docs/Docker-Deployment.md` 的部署差异节）
- [ ] 若进默认值 → 按对账规则**改 impl 不改 doc**，并把 CHANGELOG 里的实测数据
      附到 `memory-system` §4.1.1 的预算决策记录里
- [ ] 若作为部署覆盖 → 在文档里显式列出「线上 ≠ 仓库默认」的差异清单
- [ ] 一并评估 `life.generateSummary` / `profile.deepRewrite`（KI-1/KI-2 同族）

## 为什么现在不做

1. 它**不影响**正在推进的委托任务链路（`connect-server-dsh-bridge`）；
2. 判定「进默认值还是部署覆盖」需要用户拍板（是产品口味问题，不是纯技术问题）；
3. 按 `R08 / project.md`，不把它夹带进别的 change。

## 对账方向确认

- [ ] **未确认**：方向取决于上面那条判定（本 change 的全部意义就是把这个 gap 挂出来）
- [ ] 涉及 Web API？否

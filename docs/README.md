# Alysia Agent — 文档总索引

> 建立于 2026-08-07（OpenSpec 治理），**2026-10-18 重构为唯一入口**。
>
> 本页回答三个问题：**该读哪篇**、**哪篇还能信**、**哪些不许动**。
> 它不重述任何 spec 内容 —— 规范正文永远在 `openspec/specs/<slug>/spec.md`。

## 0. 给 AI 的五分钟读法

按顺序、**只读需要的**，不要一次读全部（全仓 402 个 md，读完是浪费）：

1. **`CLAUDE.md`** —— 项目上下文 + 硬约束（必读，且它是"宪法"不是文档）
2. **本页** —— 知道东西在哪、哪篇过期
3. **要改的那一个 spec** —— `openspec/specs/<slug>/spec.md`（先查 `specs/index.md`）
4. **动接口才读** `docs/Web-API-Design.md` —— 137 处引用，跨端契约
5. **开工前扫一眼** `docs/TODO.md` —— 这件事是不是已经有人登记过

**F 类（时点记录）默认不读**：只在你需要追"为什么当初这么做"时读，
且**先看文件头 3 行**（`status` / `updated`），别把 10-02 的存档当现状。

## 1. 分类总表（A–H）

分类依据是**读者拿它干什么**，不是写作时间。
`status` 语义：`current` 可依据 / `record` 时点记录会过期 / `superseded` 已被取代 / `dead` 对象已不存在。

| 类 | 文档 | status | updated | 受众 |
|---|---|---|---|---|
| **A 宪法** | [`../CLAUDE.md`](../CLAUDE.md) | current | 2026-10-18 | ai |
| | [`../openspec/project.md`](../openspec/project.md) | current | — | ai |
| **B 规范** | [`../openspec/specs/index.md`](../openspec/specs/index.md) — 24 个子系统 + Backlog 正文 | current | 2026-10-18 | both |
| **C 契约** | [`Web-API-Design.md`](Web-API-Design.md) | current | 2026-10-17 | both |
| **D 手册** | [`SERVER-ACCESS-SOP.md`](SERVER-ACCESS-SOP.md) — **怎么连服务器**（SSH/Workbench/控制台、密钥、端口、排查；**gitignored**） | current | 2026-10-20 | human |
| | [`Docker-Deployment.md`](Docker-Deployment.md) — **内部**发版 SOP（gitignored） | current | 2026-10-15 | human |
| | [`DEPLOYMENT.md`](DEPLOYMENT.md) — **对外**部署指南（受众不同，非重复） | current | — | human |
| | [`PROJECT-TASK-SOP.md`](PROJECT-TASK-SOP.md) — 委托任务 SOP（人看流程 + 她看规则） | current | 2026-10-18 | both |
| | [`dsh-migration-guide.md`](dsh-migration-guide.md) — 迁移参考 | current | 2026-10-02 | ai |
| **E 待办** | [`TODO.md`](TODO.md) — ★ **待办总表（导航层）** | current | 2026-10-18 | both |
| | [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) — 缺陷登记册正文（26 条 KI） | current | 2026-10-17 | both |
| | [`SILENT-FAILURE.md`](SILENT-FAILURE.md) — ★ 静默失败族根因审计（含 **§4.3 第四形态「不可达」**，2026-10-24） | current | 2026-10-24 | both |
| | [`../openspec/changes/`](../openspec/changes/) — 在办 change（12 个） | current | — | both |
| **F 时点** | [`HANDOFF.md`](HANDOFF.md) — 会话转接；⚠️ **4 个状态叠层，以顶部"当前状态"为准** | record | 2026-10-17 | ai |
| | [`SESSION-2026-10-18-DELEGATED-RUNTIME.md`](SESSION-2026-10-18-DELEGATED-RUNTIME.md) | record | 2026-10-18 | ai |
| | [`E02-E03-ABOUT-PAGE-RECORD.md`](E02-E03-ABOUT-PAGE-RECORD.md) | record | 2026-10-18 | ai |
| | [`CODE_REVIEW_FIX_PLAN.md`](CODE_REVIEW_FIX_PLAN.md) — 2026-07-30 的 CR，**已全部修完** | superseded | 2026-07-30 | human |
| | [`CODE_REVIEW_FIX_PLAN-2026-08-29.md`](CODE_REVIEW_FIX_PLAN-2026-08-29.md) — P0 已修 | record | 2026-10-11 | human |
| | [`ALYSIA-DSH-BRIDGE-FEASIBILITY.md`](ALYSIA-DSH-BRIDGE-FEASIBILITY.md) ⚠️ 被引用 | record | 2026-10-17 | ai |
| | [`ALYSIA-DSH-BRIDGE-PLAN.md`](ALYSIA-DSH-BRIDGE-PLAN.md) ⚠️ 被 spec 引用 | record | 2026-10-17 | ai |
| | [`ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md`](ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md) ⚠️ 被 spec 引用 | record | 2026-10-17 | ai |
| | [`ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md`](ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md) ⚠️ 被 spec 引用 | record | 2026-10-17 | ai |
| **G 参考** | [`dsh-plugin-architecture.md`](dsh-plugin-architecture.md) — dsh 原理 + 本仓模块化设计 | current | 2026-10-01 | ai |
| | [`PROMPT-INVENTORY.md`](PROMPT-INVENTORY.md) — ★ **提示词与上下文现状总账**（17 条链路各注入了什么 / 两张块表逐块 / 6 条静默断点；**改任何链路提示词前必读**） | current | 2026-10-24 | both |
| | [`frontend-map.md`](frontend-map.md) — 前端区块词汇表（**改前端前必读**） | current | 2026-10-03 | both |
| **H 废案** | [`WebUI-PRD.md`](WebUI-PRD.md) — 对象 `packages/webui` **已删** | dead | 2026-10-02 | — |

## 2. ⚠️ 不许移动的文件（挪 = 改规范 / 断链）

2026-10-18 整理时确认：**全部文档路径保持原样**，因为下面这些被**活 spec 正文**引用，
移动任何一个都要改 spec 或给历史链接做存根：

| 文件 | 谁在引用它 |
|---|---|
| `ALYSIA-DSH-BRIDGE-SERVER-INVENTORY.md` | `specs/dsh-adapter/spec.md` §2.7（证据出处） |
| `ALYSIA-DSH-BRIDGE-PROBE-2026-10-17.md` | 同上 |
| `ALYSIA-DSH-BRIDGE-PLAN.md` | `specs/project-tasks/spec.md` §1（上游计划） |
| `Web-API-Design.md` | 137 处（代码注释 / spec / 脚本） |
| `KNOWN-ISSUES.md` | 69 处（各 spec 与 archive 的 KI 引用） |
| `HANDOFF.md` | 62 处 |

⇒ **整理靠本页 + 文件头状态块，不靠搬目录。**

## 3. 维护规则

1. **新增文档**：放 `docs/` + 在 §1 加一行 + 文件头加 3 行状态块。缺任一步，等于没建。
2. **状态块格式**（放在 H1 之后）：
   ```
   > status: current | record | superseded | dead
   > updated: YYYY-MM-DD
   > audience: ai | human | both
   ```
3. **过期不删**：降级为 `record` / `superseded`，并在这里标注。删掉历史 = 下次重新踩同一个坑。
4. **本页不重述 spec**：只说"在哪、还能不能信"。想写内容请写进对应 spec。
5. **表长上限 ~30 行**：超了说明文档在增生，不是在增长。
6. **查阅界面**：`node docs/site/serve.mjs` → <http://127.0.0.1:7801/>
   （Windows 也可以直接双击根目录的 `start-docs.bat`）。只读文档站。
   它**现解析本页 §1 的表格**当导航 —— 改这张表，站点侧栏跟着变，**不需要重新生成任何东西**。

## 4. 三分钟了解这个项目

| 想了解 | 看 |
|---|---|
| 开发纪律 / change 流程 | [`../openspec/project.md`](../openspec/project.md) |
| 整体架构 / 模块划分 | `openspec/specs/alysia-architecture/spec.md` |
| 记忆怎么存 / 怎么检索 / 怎么提炼 | `openspec/specs/memory-system/spec.md` |
| 她的一天（主动生活） | `openspec/specs/ai-life-system/spec.md` |
| 新功能开工前 | `openspec/specs/index.md` → 对应 spec → `docs/TODO.md` |
| **现在还剩什么没做** | [`TODO.md`](TODO.md) |
| 踩过的坑 / 死路 | 各 spec 的"已知限制"节 + [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md) |
| 历史实施记录 | `openspec/archive/`（141 个归档 change） |

# Change Proposal: cut-dsh-memory-bridge

## 元信息

- **日期**: 2026-10-24
- **类型**: MODIFY（改行为 —— 配置开关，非代码逻辑）
- **状态**: **archived**（2026-10-24 归档。配置已改并机器验证 `bridge === false`；
  ⏳ **唯一未完成项：需重启 dsh 才生效** —— 重启后确认日志 `记忆通道已关闭`，见 tasks 验收项）
- **影响 spec**: `dsh-adapter`（§2.5 消息 ingest hook —— 补「当前部署该通道关闭」）
- **上位计划**: [`docs/PLAN-2026-10-24-context-and-rules.md`](../../docs/PLAN-2026-10-24-context-and-rules.md) 的「方向变更」

## 动机

用户 2026-10-24 决定：**dsh 的昔涟模式基本不用了，重心不放在这里，并先切断它对记忆系统的影响。**

这不是"功能不要了"，而是**止损**：dsh 通道会往我们的记忆系统里**写**两样东西，而这两样都不受我们控制：

| 写入点 | 落到哪 | 后果 |
|---|---|---|
| `POST /api/ingest`（`turn/end` 批量回传） | `events` 表 | dsh 会话的每句对话进事件流，参与召回 |
| `POST /api/sessions/:id/extract`（`session/disposed`） | **摘要 + 画像事实 + 人格确认** | **`ProfileExtractor` / `PersonaAdapter` 会据此改我们的画像与人格参数** |

第二条是重点：一个"基本不用"的通道，仍然在**改她是谁**。

## 需求（做什么）

- [x] **仓库源码**：`packages/dsh-adapter/cordis.patch.yml` 的 `alysia-adapter` 行加 `config.bridge: false`
- [x] **安装侧自动生效**：`~/.dsh/profiles/{desktop,alysia-webtest}/node_modules/@alysia/dsh-adapter`
      是 **Junction → 仓库包**（`Get-Item .LinkType = Junction`），改仓库即两个 profile 同时生效，
      **无需改副本**（本条初稿误判成"实体拷贝"，已更正）
- [x] spec 补一行：当前部署该通道关闭

## 设计决策

**选 A：只切「写」，保留「读」。**

| 通道 | 处置 | 理由 |
|---|---|---|
| `ingest`（写事件） | **切断** | 污染记忆库 |
| `session/disposed` → `extract`（结算） | **切断** | 污染画像 + 人格参数（同一个 `installBridge`，一处开关同时关掉） |
| 记忆预热 / `alysia:memory` provider | 顺带失效 | 缓存只在 `else` 分支填充 ⇒ 关闭后 provider 返回空串 |
| `recall_memory` 工具 | **保留** | 单向读取、无污染；偶发用到时记忆还在 |
| 人格注入 `{{alysia_persona}}` | **保留** | host 行独立（`persona: xilian`）；关它属于 B/C 档，用户选 A |

**否决 B/C**：连读与人格一起断，会让"偶尔开一下"变成完全空壳；而污染源是写，不是读。

**否决「改代码硬编码关闭」**：`bridge` 本来就是为此存在的开关（`index.ts:205`），硬编码会毁掉这个能力。

## 对账方向确认

- [x] **改 doc**：`specs/dsh-adapter/spec.md` §2.5 必须写明「当前部署该通道关闭」——否则下次读 spec 的人会以为
      dsh 对话**正在**进记忆库，从而做出错误的对账（把"没数据"当成"实现坏了"）
- [x] 涉及 Web API？**否**。`/api/ingest` 与 `/api/extract` 端点**保留不动**（只是不再被调用），
      契约文档无需改；但要在 spec 里写清"端点留着，客户端关了"

## 不做的事（明确边界）

- ❌ **不清理历史数据**（用户决定：「已写入的就先不管了，问题不大」）。
  之前 dsh 写进去的 `synthetic` 事件与派生 facts **继续留在库里**。
  如需评估：`scripts/synthetic-data-audit.cjs`（只读复验）。**本 change 不做。**
- ❌ 不删 adapter 包、不禁用 preset、不改 `persona: xilian` —— 随时可恢复。
- ❌ 不动 `recall_memory` 工具。

## 测试计划

无单测可加（纯配置）。验收靠三件事：

1. **日志**：dsh 重启后应出现 `[alysia-adapter] 记忆通道已关闭（config.bridge=false）——只剩 recall_memory 工具`
2. **库**：在 dsh 里说几句 → `events` 表**不应**新增 `session_id LIKE 'dsh:%'` 的行
3. **反向确认**：`recall_memory` 仍可用（通道只切了写）

## 风险

- ⚠️ **安装形态是 Junction**：`dsh plugin` 重装/升级**可能把它变成实体拷贝**（那样改仓库就不再影响已装）。
  重装后必须复查 `Get-Item <profile>\node_modules\@alysia\dsh-adapter | Select LinkType` 与 `bridge: false` 是否还在 ——
  否则通道会**静默恢复**。这条要写进 tasks 的永久验收项。
- ⚠️ 关掉后**画像不再更新**：dsh 里发生的事我们永远不知道。这是有意的取舍（不再使用该模式）。

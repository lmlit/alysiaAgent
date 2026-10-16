# Change Proposal: fix-persona-adapter-json-tolerance

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（静默失效）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `memory-system` §4.1.1 **新增契约 4**
- **来源**: `docs/KNOWN-ISSUES.md` **KI-4**

## 这条要解决什么

`PersonaAdapter.processSignal` 用**裸 `JSON.parse(response)`**，catch 里只写一句注释
「LLM returned invalid JSON, skip」就放弃 —— **无日志**。

后果：模型偶发把 JSON 包在 ` ```json ` 围栏里（很常见）时，
**人格自适应静默失效**：没有人格调整、也没有任何痕迹，
看起来和"这轮确实不需要调整"**一模一样**。

**★ 背景（这条最值钱）**：这个坑项目里**已经修过一次**。`utils/llm-json.ts` 的头注写着：

> "剥 markdown 围栏再 JSON.parse" 这个需求在项目里出现了两次——**只做对了一处**。
> 线上后果：会话摘要在 2026-09-04 ~ 09-25 期间 **100% 失败（22 天）**，全部静默。

`ProfileExtractor` / `SessionEndProcessor` 当时都换成了共用解析器，
**只有 `PersonaAdapter` 还留着裸写法** —— 本 change 把它对齐。

## 需求（做什么）

- [ ] **R1**：改用共用解析器 `parseLLMJson()`（剥围栏 + 空判 + 截断检测）
- [ ] **R2**：解析不出来（`bare` / `empty`）→ **限频 warn**，不许静默
- [ ] **R3**：**区分三种"没有调整"**，不许混为一谈：
      ① 解析失败（要 warn）② 合法 JSON 但字段不合法（不 warn）③ `adjustments: []`（不 warn）
- [ ] **R4**：复用既有共用实现，**不新写一套判据**（那正是本项的病根）

## 设计决策

### D1 复用 `utils/llm-json.ts`，不自己写剥围栏

那正是 KI-4 的教训：**同一个需求抄两份、只做对一处**。
复用还顺带获得它的两个既有能力：`looksTruncated()`（区分"说了句人话"与"话说到一半被掐"）
与三分支判别联合。

### D2 用 `warnThrottled` 而不是 `logger.warn`

人格扫描是**每条用户消息**都走的路径 ⇒ 逐条 warn 会刷屏
（本仓已有这个手法，也是 `add-ops-health-report` 的前置教训：噪声会淹掉信号）。

### D3 R3 的三分法是刻意的（有专门用例）

"解析失败"与"合法但无需调整"**必须分开**：把后者也报成失败，
等于把真失败**淹掉**——那是本仓反复栽的另一半（噪声埋信号）。

## 测试计划

`packages/core/tests/memory/unit/persona-adapter-json.test.ts`（新，7 例）：

| 编号 | 场景 | 验收 |
|---|---|---|
| S1 | 裸 JSON | 照常解析（回归） |
| S2 | **```json 围栏**包着（主症） | **照常解析**（旧实现返回 null） |
| S3 | 围栏**前后带空白** | 也要剥掉（`^`/`$` 锚定最容易漏这种输入） |
| S4 | 模型返回裸文本 | 返回 null **且 warn** |
| S5 | 模型返回空串 | 返回 null **且 warn** |
| S6 | `adjustments: []`（合法的"不需要调整"） | 返回 null **但不 warn** |
| S7 | 合法 JSON 但字段类型不对 | 返回 null **但不 warn** |

⚠️ **测试输入必须能过 `processSignal` 的信号前置过滤**
（`太+|能不能别|我喜欢|我讨厌|不要|别|更|再`）。
我第一版用了 `随便聊聊` / `在的`，**根本没走到 LLM**——
S6/S7 因此"因为错误的理由通过"（空转）。已改成能触发的输入，这类假通过必须自己抓。

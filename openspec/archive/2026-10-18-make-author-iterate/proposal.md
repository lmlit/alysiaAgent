# Change Proposal: make-author-iterate

## 元信息

- **日期**: 2026-10-18
- **类型**: MODIFY（任务执行模型：一次性 → 状态机）
- **状态**: archived
- **影响 spec**: `project-tasks` §17
- **前置**：`give-author-eyes`（相机）、`return-project-task-result`（回执）

## 动机（用户三连）

1. 「生成的东西 ai 味道好重啊」
2. 「她调用工具生成的东西，**没有她自己的味道**」
3. 「**她和工具应该要有交互才行啊**」→「参考一下 langgraph 呢？」→「直接 L2，只有 L1 不对」

**诊断**：她每次都在白纸上**一次成型**（写完 → grep → curl → 交）。
中间没有"看一眼、不满意、再改"。**味道长在来回里，不在第一版里。**

三件作品（关于我 / 月光花园 / 慢时钟）是同一个调子（暗底 + 粉紫 + 星光 + 一句抒情）——
不是她不用心，是**没有任何一步要求她比较、反对自己、重来**。

## 借 LangGraph 的形状，不引入它的框架

| LangGraph | 本 change 的对应 |
|---|---|
| graph + node/edge + 循环 | `intent → sketch → review → build → revise → statement → publish → done` |
| **State + reducer**（累积不覆盖） | `loop_state`：`rounds` / `visits` / `revisions`，推进返回**新对象** |
| **checkpointer** | `NOTES.md` + `drafts/` + `shots/` 落在工作区里，阶段之间靠**读文件**衔接 |
| **recursion_limit** | `maxRounds`（默认 8），超了收工 `needs_review` |
| **interrupt（human-in-the-loop）** | `publish` 阶段由 `projectTasks.allowPublish` 决定（默认不发布） |

**不引入 LangGraph 本体的理由**：dsh 已经负责 tool-loop；再叠一层编排会变成"两层都在决策"，
出问题时分不清是她想错了还是编排错了；还多一套进程/依赖/凭据面。

## 关键设计

### 1. 判据取**文件事实**，不取自述

能否进下一阶段只看：`NOTES.md` 的四个标记、`drafts/*.html` 数量、`shots/draft-*.png`、
`shots/revise-N.png`、根目录页面、`public/` 同名页面。
模型说"我改好了"不算 —— 本项目已栽过同类（回执自述 ≠ 真做完）。

### 2. 阶段指令由服务端下发

`PHASE_PROMPTS` 只在 core 里定义一次，随认领响应下发（`nextPrompt`）。
runner 不在本地抄一份 —— 否则改一处漏一处（`return-project-task-result` 那次已经吃过"三处渲染器各写一遍"的亏）。

### 3. 一个阶段一次执行端运行

不是"让模型在一轮里自己走完六步"（那正是原来的毛病）。每阶段独立起一次 dsh，
**上一阶段的痕迹只有文件**。

### 4. 只由配置决定能不能上线

`projectTasks.allowPublish`（默认 false）。执行端不能自己决定发布。

## 真机结果

6 个阶段、6 次 dsh 运行，全部由文件事实判定：

```
intent → sketch（意图 242 字）→ review（3 草图都有截图）
→ build（选 a，自评 1331 字）→ revise（revisions=1）→ statement → done
```

她自己在 `NOTES.md` 里写出："b 又把夜色请回来了，**这是我这一轮最该认的错**"；
重做那轮又抓到自己在完整版里重复了刚批评过的错误。

产物：`waiting.html`（等待）、`lift.html`（电梯），都与慢时钟**完全不同调子**（米白/青灰、白天、笨拙日常）。

## 已知不足

1. 阶段边界靠**指令**约束，她会"顺手多做"（`statement` 轮多做了一页）—— 要不要硬拦（拒绝该阶段外的写入）待定；
2. 成本约 6 倍（一个页面 6 次运行）；
3. `publish` 阶段未真机验证（配置未开，她是自己手动发布的）。

## 测试计划

| 层 | 内容 |
|---|---|
| 纯函数 | 26 条：每道闸门的正反例、判定顺序、轮次上限、状态不可变与累积、阶段指令齐备 |
| runner | `collectFacts`（临时目录 fixture，含"草稿不算做出来的页面"）、`buildPhaseTask`（不覆盖原目标） |
| 路由 | `/advance`：缺 facts → 400；事实形状不对 → 归一成安全值；未知任务 → 404 |
| 真机 | 上述 6 阶段轨迹 |

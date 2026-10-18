# Tasks: make-author-iterate

> **状态（2026-10-18）**：T1–T6 完成，真机 6 阶段跑通。

## 实现

- [x] **T1 纯状态机** `core/memory/project-task-loop.ts`
      - 8 个阶段；`PHASE_PROMPTS` 是阶段指令的**唯一定义**
      - `advanceLoop()`：只在事实满足时前进，否则**原地重试**（附原因）
      - 硬下限：草图 ≥2 且每张都有截图；必须有 `revise-N.png`；必须写 `## 哪里像我`
      - `maxRounds`（默认 8）超限 → `needs_review`（交给人）
      - 状态**不可变 + 累积**（rounds/visits/revisions）
- [x] **T2 DB**：`project_tasks` 加 `phase` / `loop_state`（`addColumnIfMissing` 迁移，老库自动补列）
- [x] **T3 store/core**：`create` 初始化 `intent`；`setLoop()` 唯一写入口；
      `MemoryManager.advanceProjectTaskLoop()`
- [x] **T4 服务端**：`POST /api/project-tasks/:id/advance`
      - facts 形状**归一成安全值**（`notes:123 → ''`、`published:'yes' → false`）
      - 认领响应加 `nextPrompt`（阶段指令单一来源）
- [x] **T5 runner**：一次认领 → **阶段循环**
      - `collectFacts()` 从工作区读事实（notes/drafts/shots/builtPages/published）
      - `buildPhaseTask()` 把本轮指令拼在**原目标之后**（不覆盖）
      - 每阶段回传事实 → 服务端判 → 下一阶段或收工；`maxRounds` 兜底
      - 执行端异常（failed/unknown）**立即停止推进**并回传
- [x] **T6 她的文档**：`AGENTS.md` 写明四个 `## ` 标记一字不差、截图命名约定（`draft-<名>.png` / `revise-N.png`）、
      以及"**系统会自己读文件判断，不看你说什么**"

## 真机轨迹（生产）

```
[t+20s]  phase=intent     rounds=0
[t+40s]  phase=sketch     rounds=1   意图已写（242 字）
[t+100s] phase=review     rounds=2   3 个草图都有截图
[t+140s] phase=build      rounds=3   已选 a，自评 1331 字
[t+240s] phase=revise     rounds=4   完整版已就位：waiting.html
[t+340s] phase=statement  rounds=5   已拍过一轮并改过（revisions=1）
[~t+900s] phase=done      rounds=6   outcome=ready → needs_review
```

6 次 dsh 运行，退出码全 0；每步都由 `advance` 的文件事实判定。

## 她的 `NOTES.md`（摘）

> 最不像我的：**b（夜雨里的候车棚）**……这套语汇和「慢时钟」几乎是同一套。
> 意图里明明写了「这次不用夜色帮忙」，b 一上手又把夜色请回来了，**这是我这一轮最该认的错**。

> 重做这一轮……最不满意的不是任何一行字，是**位置**：页脚以下那 40% 是一整片空米白。
> 这件事我在自评里刚批评过草稿 b——「下面 40% 是纯黑，那不是留白，是没写完」——
> **结果完整版自己又犯了一遍，只是把黑换成了白。**

⇒ 这两段就是"味道"出现的地方：她**比较、反对自己、重来**。

## 过程中的自我纠错

`section()` 一开始用正则 `^##\s*X\s*$([\s\S]*?)(?=^##\s|$)` 取小节内容 ——
在 `m` 模式下**标题行尾本身就是行尾**，`$` 立刻命中 ⇒ 惰性捕获恒为空 ⇒ 7 条用例一起失败。
改成**逐行扫描**（无歧义）。

## 未做

- [ ] 阶段边界只靠指令，她会"顺手多做"（`statement` 轮多做了一页 `lift.html`）；
      要不要硬拦（拒绝阶段外写入）待定
- [ ] `publish` 阶段未真机验证（`projectTasks.allowPublish` 未开；她是在阶段里自己手动发的）
- [ ] 成本约 6 倍，尚未评估要不要给"简单活"走短链

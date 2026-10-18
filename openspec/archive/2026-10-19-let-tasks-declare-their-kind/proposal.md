# Change Proposal: let-tasks-declare-their-kind

> 模板：复制到 `openspec/changes/<change-name>/proposal.md` 使用。
> 开发纪律见 `openspec/project.md`：任何行为变更必走 propose → apply → archive。

## 元信息

- **日期**: 2026-10-19
- **类型**: FIX（状态机空转）
- **状态**: **archived（2026-10-19）**
- **影响 spec**: `project-tasks`（§17 新增契约 68f；§10/§16 的任务模型）

## 动机（为什么做）

**真机事故**（2026-10-19 00:2x）：一个目标写「用 `publish_page` 把 island.html 发布一次，
不要改文件」的任务，被套上六阶段循环：

```
16:23:41 [第 1 轮] intent   → 闸门：NOTES.md 里还没有「## 意图」
16:24:29 [第 2 轮] intent   → 同上
… 一直转到第 7 轮，每轮都真跑了一次 dsh（真花钱）
```

而那 7 轮里她**连着调了 5 次 `publish_page` 并且每次都成功**（日志有据）。
闸门要的是「## 意图」，目标说的是"别改文件" —— **两者根本不兼容，于是空转**。

根因：`make-author-iterate` 把「六阶段」当成了**所有**任务的形状。
可"做一件新东西"和"做一件事（发布/核实/改一处）"是两种活。

## 需求（做什么）

- [ ] 任务带**类型** `kind`：`build`（默认，六阶段）/ `action`（单轮，做完就交）
- [ ] `action` 任务：**不拼阶段指令**（否则她会被"这一轮只写意图"带偏）、**不做闸门判定**，
      跑完一轮就 `needs_review`
- [ ] 她能自己声明类型：`start_project_task` 加 `kind` 参数（说明里写清哪种活对应哪种类型）
- [ ] HTTP `POST /api/project-tasks` 也接受 `kind`（探针/外部调用用）
- [ ] **防空转兜底**：同一阶段连续卡 4 次 ⇒ 收工 `needs_review`（别烧到 `maxRounds=8`）

## 设计决策（怎么做，含备选与取舍）

1. **类型由提交方声明**，而不是服务端猜目标文本。理由：只有她知道自己在交什么活；
   猜错的代价（要么空转、要么把该来回的活压成一次）都比多写一个参数大。
   - 她滥用的后果有限：`action` 只是**少了来回**（质量机制），不是绕过任何权限。
2. **`action` 连阶段指令都不给**，不只是跳过闸门 —— 真机上第一次跑 `action` 时，
   服务端仍下发了 intent 指令，她就真的跑去写「## 意图」而**没有发布**。
   （runner 侧也加了一道防御：单轮任务强制把 `nextPrompt` 清空。）
3. **`kind` 落库**（`ALTER TABLE … DEFAULT 'build'`）：老任务自动成为 `build`，行为不变。
4. **防空转用"同阶段 4 次"而不是"总轮次"**：`maxRounds=8` 是总量闸门，管不住"卡在一个阶段"；
   4 次足够容纳正常来回（草图通常 1~2 轮），又不至于让错误目标烧掉整晚。
   - 备选（否）：把 `maxRounds` 调小 —— 会误伤真正需要来回的做东西任务。

## 对账方向确认

- [x] 与契约 67（阶段化）不冲突：那条讲的是**"做一件东西"**要分阶段；本 change 只是让
      "不是做东西"的活不要被套进去
- [x] 涉及 Web API？`POST /api/project-tasks` 多一个可选字段 `kind`（向后兼容）；
      `GET /next` 的 `task` 里多一个 `kind`
- [x] 涉及她的文档（`AGENTS.md`）？**可以补一句"发布/核实这种活直接交 action"**（本 change 暂不动）

## 测试计划

- core：`advanceLoop` 同阶段第 4 次 ⇒ `finish('needs_review')`，且正常来回（sketch 一次过）不误伤
- tool：`start_project_task` 把 `kind` 传下去，缺省 `build`
- 真机：`kind=action` 的任务——日志「类型：action（单轮任务）」、9s 跑完、回执带
  「[过程] 单轮任务（action）：做完就交，不套六阶段」、`✅ 200 … island.html`

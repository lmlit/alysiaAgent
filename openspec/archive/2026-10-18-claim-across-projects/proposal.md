# Change Proposal: claim-across-projects

## 元信息

- **日期**: 2026-10-18
- **类型**: FIX（认领模型：按项目 → 跨项目）
- **状态**: **archived**（2026-10-18 归档；T1–T4 完成，生产验证）
- **影响 spec**: `project-tasks`（新增 §12）
- **前置**：`add-preview-hub`（多项目的动机）

## 动机（真机撞出来的）

为了验证"基站会自动长卡片"，我登记了第二个项目 `alysia-toys` 并提交任务。
结果：**任务停在 `queued`，等了 580 秒都没人认领**。

原因：runner 是**按项目**起服务的（systemd 里 `--project alysia-blog` 写死）。
⇒ 每加一个项目就得**再加一个 runner 服务**，漏了就**静默排队**——不是报错，是"看起来在跑"。

这一条比"要多起一个服务"更糟：**它是静默的**。如果没人为这个任务守着，
谁都不会发现她一直在等。

## 需求

- [ ] 一个 runner 服务**所有登记项目**（不指定项目）
- [ ] 由**服务端**决定先做谁的活：取**最老**的排队任务所属项目（不饿死后登记的项目）
- [ ] 保留 `--project` 作为可选（隔离/调试用）
- [ ] 排队任务的项目**已被注销**时：不执行、**留痕**、返回空（不许静默）

## 设计决策

### 1. 认领方不指定项目，服务端决定

`GET /api/project-tasks/next` 的 `projectId` 变**可选**：

```
不带 projectId → core.nextQueuedProject() 选出最老的有活的项目 → claimNext(那个项目)
带   projectId → 校验登记表 → claimNext(它)     （400 未知项目，并列出已登记）
```

★ **认领本身仍然是原子的**：`nextQueuedProject()` 只是一次 `SELECT ... ORDER BY created_at LIMIT 1`
（不改状态），真正的"找最老 → 标 running"仍在 `claimNext` 的**单个事务**里。
两个 runner 同时跑也不会双认领（那是既有契约 5），代价只是可能多一次空转。

### 2. 取"最老"，不是"第一个项目"

`projects` 是对象，遍历顺序不稳定。按 `created_at` 取最老 ⇒ 公平，不会因为某个项目一直有活
把别的项目饿死。

### 3. runner 的 `--project` 从"必填"变"可选"

⚠️ 我第一次改的时候**漏了代码里的硬校验**（`if (!cfg.project) { printHelp(); exit(2) }`），
只改了帮助文本 ⇒ systemd 里服务直接 `activating`（exit 2），日志刷满是帮助文本。
**这条记下来**：改"必填 → 可选"时，要同时搜 `process.exit` 附近的校验，不只是 usage 文案。

### 4. 不做的

- 不做多 runner 并发调度（一个 runner 串行足够；真有吞吐需求再引入租约/队列）；
- 不做项目级优先级（真需要时再加 `priority` 列）。

## 对账方向确认

- [x] 新增 core 方法 `nextQueuedProject()` ⇒ 同步 `docs/Web-API-Design.md` §2.4.5
- [x] 路由语义变化（`projectId` 可选）⇒ spec 与文档都要写清"不带则服务端挑"
- [x] 不改状态机

## 测试计划

| 层 | 内容 |
|---|---|
| store | `nextQueuedProject()`：空 → null；两个项目 → 取最老；最老被认领后 → 轮到下一个；全终态 → null |
| 路由 | 不带 projectId → 先问最老再认领该项目的任务；无活 → `{task:null}`；作业项目已注销 → 不认领 + 返回空；指定未知项目仍 400 |
| runner | `nextUrl('')` 不带查询参数；`nextUrl('a b&c')` 要 encode |
| 真机 | 曾静默排队 580 秒的 `alysia-toys` 任务：修复后 **8 秒**被认领、165 秒跑完、她自己发布、基站出现第二张卡 |

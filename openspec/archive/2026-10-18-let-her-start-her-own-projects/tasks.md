# Tasks: let-her-start-her-own-projects

> **状态（2026-10-18）**：T1–T6 完成，生产验证（含两次事故与一次相互修复）。

## 实现

- [x] **T1 决策纯函数** `core/memory/self-activity.ts`
      - `decideSelfActivity()`：开关 → 高峰 → 在途 → 日上限 → 间隔 → 闲置（**先看便宜的**）
      - `selfActivityRequestKey(dateKey, projectId)` = `self:<日期>:<项目>`（去重）
      - `selfActivityAcceptanceCriteria({allowPublish})`：验收标准**写死护栏**，默认**不许发布**
- [x] **T2 store/类型**：`origin` 增 `'self'`；读回同形判断同步（否则读回来会变成 `user`）
      新增 `countByOriginSince` / `latestCreatedAtByOrigin` / `hasActiveTask`
- [x] **T3 core**：`projectTaskStats()` / `countProjectTasksSince()` / `composeSelfActivityIdea()`
      （人格 + 事实 + 边界；**`max_tokens: 800`**，200 时空串）
- [x] **T4 服务**：`server/src/self-activity.ts`
      - 每 `intervalMinutes`（默认 30）考虑一次；**启动后等一个间隔再考虑**（避免重启就发任务）
      - 判定摘要只在"结论变化"时打日志
      - **必须显式 `projectId`，留空不发**
- [x] **T5 模块**：`al:self-activity`（**声明 `provides`**）+ `selfActivity` 配置段 + 显式映射
- [x] **T6 相邻修复**：预览服务单线程 ⇒ `scripts/preview-serve.py`（`ThreadingMixIn`，3.6 兼容）

## 真机验证

```
[SelfActivity] ✅ proceed：可以自己找点活：今日 0/1，距上次自发起（无），距用户上次说话 0.8h
[SelfActivity] ★ 她自己发起了一个小东西：pt-dbbae8e1-…（项目 alysia-blog）
库里：origin=self  status=queued
她的想法：想在 alysia-blog 里塞一页很安静的小东西：一个 24 小时才转一圈的慢时钟，
          指针走过的地方颜色会从深夜的靛蓝慢慢化开成黎明的橘…全用 CSS 和内联 SVG 画
结果：slow-clock.html（16,615 B，单文件零外链），**没发布**，index.html 哈希未变（8380c7a09ebe）
```

## ★ 事故 1：`provides: false` + `ctx.provide()` ⇒ 容器崩溃循环

```
[kernel] 模块 "al:self-activity" apply 失败：试图 provide 未声明的服务 "al:self-activity"
Failed to start Alysia: …
RestartCount=7   Restarting (1)
```

**服务真的挂了约 10 分钟**（16:03–16:05 起循环）。
教训：`ctx.provide(name, x)` 必须配 `provides: [name]`；否则不是"这个模块挂了"，
而是**整个进程起不来**。
⇒ 已修，并在模块注释里写明原因（不然下一个人还会这么写）。

## ★ 事故 2：落错项目（一个验证触发的任务差点改正式页面）

"留空 = 用登记列表最后一个" ⇒ 她落到 `alysia-blog`（精心做的「关于我」页），
而不是练手项目 `alysia-toys`。

**实测结果**：她**没有**动 `index.html`（哈希一致），只新建了 `slow-clock.html`。
**但那是运气，不是设计** —— 目标里说"塞一页"，她刚好理解成新文件。

⇒ 现在：`projectId` **必须显式配置，留空不发**（并在启动时警告）。
生产配置：`selfActivity.projectId: alysia-toys`。

## ★ 事故 3：预览服务两个 3.6 兼容坑

1. `SimpleHTTPRequestHandler(directory=…)` 是 **3.7+** ⇒ 在 3.6 上每个连接抛 TypeError ⇒ **全部 000**
2. 越界防护用 `realpath` ⇒ 把 `p/<项目>` 的**符号链接**误判成越狱 ⇒ 页面静默回落成基站首页（16224B → 2455B）

⇒ 现在用 `os.chdir` 定根 + **词法**校验；实测 20 路并发全 200、目录列表 404、`../` 404。

## 实测数据

- 全仓 **121 文件 / 1490 用例**绿（新增 `self-activity.test.ts` 15 条）
- 预览服务：20/20 并发 200；`/p/alysia-blog/` 16224B（正确大小）

## 未做

- [ ] "idle 时决定做"目前是**定时器 + 概率式**（不是她读了生活事件之后的自主决定）；
      真正接进 `LifeService` 的事件生成需要另一个 change
- [ ] 不允许发布（`allowPublish` 默认 false）；要开就是一次配置改动
- [ ] 没有"她自己的作品集索引"（基站已经是自动索引，够用）

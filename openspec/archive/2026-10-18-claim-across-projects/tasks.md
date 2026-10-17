# Tasks: claim-across-projects

> **状态（2026-10-18）**：T1–T4 完成，生产验证（含一次自我纠错）。

## 实现

- [x] **T1 store**：`ProjectTaskStore.nextQueuedProject()`
      - `SELECT project_id ... WHERE status='queued' ORDER BY created_at ASC LIMIT 1`
      - **只读**（不改状态）⇒ 认领的原子性仍由 `claimNext` 的单事务保证
- [x] **T2 core**：`MemoryManager.nextQueuedProject()`
- [x] **T3 路由**：`projectId` 变可选
      - 不带 ⇒ `nextQueuedProject()` → `projectOr(pid)` → `claimNextProjectTask(pid)`
      - 排队项目已被注销 ⇒ 不执行 + `warn` 留痕 + 返回空（不许静默）
      - 带未知项目 ⇒ 仍 400 并列出已登记
- [x] **T4 runner**：`nextUrl(project)` 抽成纯函数（可测）；`--project` 变可选；
      去掉 `if (!cfg.project) exit(2)` 的硬校验
      - ⚠️ **自我纠错**：第一次只改了 usage 文案、漏了硬校验 ⇒ 服务 `activating`、日志刷满帮助文本。
        查到后修正并补上 `nextUrl` 的单测。

## 测试

- [x] store：空 → null；两项目取最老；最老被认领后轮到下一个；全终态 → null（+4）
- [x] 路由：不带 projectId 先问最老再认领；无活 → `{task:null}`；作业项目已注销 → 不认领 + 返回空；未知项目 400（+4）
- [x] runner：`nextUrl('')` 不带 query；带 project 正确；特殊字符要 encode（+3）
- [x] 全仓 **117 文件 / 1424 用例** 绿

## 真机验证

- [x] 修复前：`alysia-toys` 的任务**静默排队 580 秒**
- [x] 修复后：服务重启 **8 秒**即被认领 → 165 秒跑完 → `needs_review`
- [x] 她自己 `./publish.sh` 发布成功（四条 ✅；一条 ⚠️ 是她页面里的内联 `<script>`，无 `src`，
      她自己也解释了「属于提示不算失败」）
- [x] 基站自动变成**两张卡**：
      「月光花园 · 昔涟的小玩意」`/p/alysia-toys/`（200 / 8366B）
      「昔涟 · 关于我」`/p/alysia-blog/`（200 / 15265B）
- [x] 顺手验证了"她要读 AGENTS.md / publish.sh"这件事在两个项目里都成立（脚本通用，靠 `.alysia-project.json` 区分）

## 未做

- [ ] 多 runner 并发调度（一个串行 runner 足够；真有吞吐需求再引入租约）
- [ ] 项目级优先级（需要时再加 `priority` 列）

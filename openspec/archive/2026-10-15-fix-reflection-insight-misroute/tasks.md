# Tasks: fix-reflection-insight-misroute

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `MemoryManager.recordReflection()`：`insight` 由 `profileStore.addFacts()`（用户画像）
      改为 `addCharacterFacts()`（角色画像）
- [x] 去掉 `category: 'preference'` 硬编码 → `general`（`addCharacterFacts` 按 category 设 TTL，
      `preference` 是用户偏好类目且 90 天 TTL 对自省语义不对）
- [x] 同步修正该方法的 docblock（原写「insight 进画像 facts」，未区分用户/角色）
- [x] `PromptAssembler`：新增 `CHARACTER_FACTS_IN_PROMPT = 8`，【关于我】块取最近 8 条
      （★ 迁移后实测该块 705 tokens / 占 3200 预算 22%，且是最后一个 `canFit` 检查的块，
      超预算整块被丢 = 她一条都读不到）
- [x] 测试：`tests/memory/unit/reflection-insight-routing.test.ts`（5 例，锁定路由 + category + 去重 + reflection 不受影响）
- [x] 测试：`tests/memory/unit/PromptAssembler.test.ts` 新增 1 例（12 条事实 → 只注入最近 8 条，且库里仍保留 12 条）

## 数据迁移任务

- [x] 写迁移脚本，**逐字复刻** `ProfileStore.addCharacterFacts` 的 `normalizeKey` / `normContains` / supersede 语义
- [x] 停容器 → 备份 `/root/alysia/data`（`/root/alysia-backup-20261015-231624/`）
- [x] dry-run 验证 → 实跑
- [x] 起容器并验证 `/api/health`
- [x] 复核：`facts` 中残留第一人称自述 **= 0**；`character_facts` = 31 active；`integrity_check` = ok

## 验证任务

- [x] 新测试全通过（5 + 1 = 6 例）
- [x] **全量非 E2E 回归：87 文件 / 1010 用例全通过**
      （首轮出现 1 例 `al:db` 建库 5s 超时；**单独跑 557ms 通过**，判定为并发抖动，与本 change 无关）
- [x] 线上迁移前后数据对比（84→51 / 0→31）
- [x] **修正立项时的一个错误预测**：原以为「31 条会被去重收敛成若干条」——
      实测 **supersede 0 条**，`normalizeKey` 对日记型长句无效。已写回 proposal 与 spec

## Apply 任务

- [x] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（末尾新增「每日反思闭环的数据落点」一节）
- [x] 更新 `openspec/specs/index.md`：`ai-life-system` 行「最后变更」
- [x] 索引 Backlog 表登记**「已归档但未部署」**（不让线上活跃 bug 隐形）
- [x] 归档到 `openspec/archive/2026-10-15-fix-reflection-insight-misroute/`

## ★ 未完成：部署（阻塞在用户决策上）

**线上容器仍跑旧代码** → 下一次每日反思仍会错写 1 条。三个选项见 proposal 的「★ 部署依赖」：

- **A** 走正常发版 —— 干净，但会把 19 个未提交的 `packages/console` 改动一起烤进镜像
- **B** 热补容器（`docker cp` 编译产物）—— **不可复现、容器重建即丢**，与项目「不留隐形状态」纪律冲突
- **C** 先不动 —— 每天多 1 条脏事实（迁移脚本可重跑）

**需要用户拍板。**

## 备注：本 change 明确不做

- **不改 `LIFE_REFLECTION_PROMPT` 语义** —— 它本来就是对的（关于她自己）
- **不新增"关于用户的洞察"字段** —— 那是扩大能力，不是修复
- **不修 `identity` 类目的用户事实重复**（25 条里「长沙」6 次 / 「技术工作」8 次 / 「轻月」4 次）
  —— 那是 `ProfileStore.addFacts` 去重算法问题（注意：`PromptAssembler` 对**用户事实**块
  另有内联去重，所以渲染时部分重复会被折叠，但库里仍是重复的）。**独立 change**
- **不做"陈旧自省归并"** —— 限量注入是当下的治标；把 60 天日记归并成稳定自我描述是更大的设计，另开

# Tasks: fix-profile-extract-empty-response

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 系统排查（读懂代码之前不改一行）

- [x] 读失败用例 `tests/memory/e2e/cron.test.ts`（原文断言 `after.basics !== '{}'`）
- [x] **取证据而非猜测**：测试自带 `before/after` 打印 →
      `facts: 0 items` **cron 前后都是 0** → 定位到**上游** `onSessionEnd`，不是 CronProcessor
- [x] 找对照：`real-api.test.ts` 同样的 `onSessionEnd` 调用**通过** → 差异在输入/实现
- [x] 读 `SessionEndProcessor.process`：提取无 gaté，无条件执行 → 只能是 `extract()` 返回空
- [x] 读 `ProfileExtractor.extract`：发现 `catch {}` **无任何日志**，无法判断失败原因
- [x] **加临时观测**（含 `logger` import——该文件此前根本没有）→ 拿到真实异常：
      `LLM API returned empty response` + `reasoning_tokens: 1024` + `finish_reason: length`
- [x] 对照 `docs/dsh-migration-guide.md` 坑 #10 与 `sampling.ts:44-53` 的 9-25 注记 → 同源故障
- [x] 核对槽位接线：`MemoryManager.ts:133` `slotify(profile.extract)` → `ProfileExtractor`

## 缺陷修复

- [x] **A** `sampling.ts`：`profile.extract` 1024 → 4096，加 `response_format: 'json_object'`
- [x] **设计** 拆出新槽 `profile.deepRewrite`（纯文本 2048，无 `response_format`）给 `CronProcessor`
- [x] **E** `MemoryManager`：缺省 `sampling` 填 `DEFAULT_SAMPLING`（原先 undefined 导致所有槽塌成一个）
- [x] **D** `OpenAILLMService.complete`：接受第三参 `sampling` 并**替换**默认槽
      （原先只声明两个形参，TS 允许「少形参」赋给「多形参」→ 静默违约）
- [x] **B** `ProfileExtractor`：改 `parseLLMJson`（剥围栏+空判+截断分类）+ **失败记 error 日志**
- [x] **C** `CronProcessor.deepProfile`：**失败记 error 日志**
- [x] 清掉全部临时调试观测（`grep "\[debug\]" src/` 无残留）

## 测试

- [x] 新增：`OpenAILLMService` **第三参生效 + 替换语义**（接口契约回归，防 D 复发）
- [x] 加强：`max_tokens` 守卫**补上 profile 两个槽**（原守卫漏掉它们——这正是 bug 逃逸的缝）
- [x] 重写：`response_format` 守卫按**输出契约**分类（结构化槽必须带 / 纯文本槽必须不带），
      不再按槽名列举
- [x] 更新：`mergeSampling` 默认值快照
- [x] E2E：`cron.test.ts` 通过（**失败用例本身**）
- [x] 全量回归 + 全部 E2E

## Apply 任务

- [x] `openspec/specs/memory-system/spec.md`：补画像提取链路的采样槽契约与本次故障
- [ ] `openspec/specs/index.md` 更新
- [ ] `docs/HANDOFF.md`：把 `cron.test.ts` 从「已知失败」移到「已修复」
- [x] `config.example.yml`：同步采样默认值（**此前落后实现两个版本**，还写着 512）
- [x] `packages/server/config.yml`：同步注释（⚠️ 该文件会进部署包，只动注释不动行为）

## 验收结果（2026-10-01）

| 项 | 修复前 | 修复后 |
|---|---|---|
| `cron.test.ts` | ❌ `facts: 0` / `basics: {}` | ✅ **passed** |
| `basics` 内容 | `{}` | 真实自然语言画像（5 年后端 / TS+Rust / 显式命名 / 学 Rust 智能指针…） |
| `facts` | 0 | 7 |
| 常规全仓 | 818 | ✅ **820 passed**（+2 新守卫） |
| E2E（真 API） | 4 过 1 败 | ✅ **5 passed / 4 files** |
| core / server tsc | — | ✅ 均退出码 0 |

## 遗留 / 未做

- **`PersonaAdapter` 仍用裸 `JSON.parse`**（`:57`）：同样有静默 catch 的味道，
  但 prompt 含 "JSON"、未观测到失败。**一次只修被证据坐实的问题**，不为「看起来一样」扩大面。
- **`OpenAIProvider`（生产链路）的采样槽未纳入本 change 的 E2E 覆盖面**：
  生产用 `AlysiaCore` 的内联 llmService（**遵守**三参契约），
  `OpenAILLMService` 是测试替身。两者行为现已一致，但**没有测试锁住这个一致性**——
  值得后续加一条「两个 ILLMService 实现对同一槽产出相同 body」的契约测试。
- **历史数据未回填**：线上 `user_profile.basics` 与 `facts` 是长期空/稀疏的，
  本次修复只保证**从此往后**正常。要不要回填取决于用户——回填需要重跑历史会话的
  `onSessionEnd`，成本与副作用都要单独评估。

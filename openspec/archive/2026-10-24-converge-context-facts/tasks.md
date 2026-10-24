# Tasks: converge-context-facts

> 结构收敛为主，唯一的行为变更是「问候里补上档位与 idle」。见 `proposal.md`。

## 实现任务

- [x] 新增 `packages/server/src/context-facts.ts`：
      `FactsSource`（4 个可选只读方法）/ `ContextFacts`（含 `problems[]`、`snapshotPresent`）/
      `collectContextFacts(src, now, { todayEventLimit })` / `idleDaysSince()` /
      `INTIMACY_TIERS` · `INTIMACY_UPGRADE_MARGIN` · `INTIMACY_RECOVERY_MIN` · `intimacyTier()`
- [x] `life.ts`：档位定义移出 + **再导出**（`export { … } from './context-facts.js'`，保住既有 import）
- [x] `life.ts`：`idleSinceLastUserMessage()` → 调 `idleDaysSince()`（算法只留一处）
- [x] `life.ts`：`relationshipBlock()` → 吃 `collectContextFacts(…, { todayEventLimit: 0 })`，**输出逐字不变**
- [x] `proactive.ts`：`contextSnippet()` → 吃 facts，亲密度带**档位 + idle**
- [x] 读源异常进 `problems[]`（事实层不写日志），两个调用方各自 debug 出声
- [x] spec `ai-life-system` §11 补「事实层单一出处」

## 测试任务

- [x] `packages/server/tests/context-facts.test.ts`（13 例）
- [x] `packages/server/tests/proactive.test.ts` +2 例（带档位与 idle / 刚说过话不出 idle）
- [x] 回归：`life-service`(82) / `life-intimacy-tier` / `proactive`(32) / `life-diary|letter|decline` 全绿
- [x] 全量 158 文件 / 1882 用例（Node 24）
- [x] **顺手纠错**：我最初把 `intimacyTier(Infinity)` 断言成 `close`，实际 `Number.isFinite(Infinity) === false`
      ⇒ 回落 30 ⇒ `distant`。用例按真实行为修正并写明这个"容易想当然的点"

## Apply 任务

- [x] 合并 spec 改动（`ai-life-system` §11）
- [x] 运行 `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`（ai-life-system 行「最后变更」）
- [x] `docs/PROMPT-INVENTORY.md` §4「亲密度」「用户近况」两行 → 已收敛
- [x] `docs/PLAN-2026-10-24` P8 拆解里第 1+3 步标完成
- [x] `docs/TODO.md` 对应行
- [x] 归档到 `openspec/archive/2026-10-24-converge-context-facts/`

## 明确不做（留给 P8 后续）

- ❌ `block-registry.ts`（第 2 步）—— `assembleChat` 的块注册表，与事实层无耦合
- ❌ `genres.ts`（第 4 步）—— 8 个体裁的预算/采样/prompt 资产表
- ❌ 事实层上提到 `core` —— 目前只有 server 两个消费者
- ❌ 修「用户近况」那条（`getUserActivitySummary` 绕过去重与时间标注）——
      它属于 `assembleChat` 的 `facts` 块，归 P8 第 2 步

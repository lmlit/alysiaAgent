# Tasks: add-llm-budget-observability

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## core · provider 层（一处改、全局见）

- [x] `src/provider/types.ts`：`LLMResponse` 加 `finishReason?: string`；
      `usage` 加 `reasoningTokens?: number`
- [x] `src/provider/openai.ts` `textChat`（非流式）：
      - 解析 `choices[0].finish_reason` → `finishReason`
      - 解析 `usage.completion_tokens_details.reasoning_tokens` → `usage.reasoningTokens`
      - 现有 `[LLM]` 成功日志追加 `finish=<x> reasoning=<n|?>`
      - **空 content 时单独 `logger.warn`**（带上 finish / tokens —— 判定"预算被吃光"的现场）
- [x] 字段缺失（非推理模型 / 老响应）时**不崩**，降级为 `undefined` 并在日志里显示 `?`

## server · 事件生成链路

- [x] `src/modules/life.ts` `generateEvent` 回调：
      - `resp.role === 'err'` → **不再静默返回空串**，`logger.warn` 记下错误文本后返回 `''`
      - 每次调用打一行槽位级日志：`[Life] event LLM: finish=.. tokens=.. reasoning=.. content=N字 (Xms)`
- [x] 确认 `server/src/life.ts:627` 的回落 warn **保留**（不复用/不删）——
      它的 message 现在有上一行兜底解释，不再有误导性

## 测试

- [x] `packages/core/tests/provider/openai.test.ts`：补 `finishReason` / `reasoningTokens` 解析用例
- [x] 同文件：字段缺失（无 `finish_reason` / 无 `completion_tokens_details`）→ 不崩、为 undefined
- [x] 同文件：空 content + `finish_reason='length'` → 返回成功但内容为空（warn 路径）
- [x] 同文件：`finish=stop` 的空响应 → warn 里明确说「不是预算问题」（防误导）
- [x] 同文件：**工具调用且无文本 → 不算空响应**（不误报 warn）
- [x] `packages/server/tests/life-service.test.ts` 既有用例全绿（**证明回调签名未变**）

## 文档

- [x] `docs/KNOWN-ISSUES.md` KI-1：状态从「没有证据」改为「**有观测手段，待采数据**」，
      并写明采数据的入口（provider `[LLM]` 行 + `[Life] event LLM` 行）
- [x] `docs/KNOWN-ISSUES.md` KI-2：加一句指向本 change 的观测能力（两个小槽顺带可观测）

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`（§4.1.1 追加观测契约）
- [x] 合并 spec.md 到 `openspec/specs/ai-life-system/spec.md`（事件生成链路日志契约）
- [x] 更新 `openspec/specs/index.md`（两个 slug 的「最后变更」）
- [x] 运行 `pnpm --filter @alysia/core test` + `pnpm --filter @alysia/server test`
- [x] core 改动**必须 build**（`cd packages/core && npm run build`）——server 走 dist
- [x] 更新 `docs/HANDOFF.md`
- [x] 归档 + 更新索引

## 验收结果（2026-10-02）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **612 passed / 63 files**（provider 用例 4 → 9，+5） |
| server 单测 | ✅ **223 passed / 13 files**（含 60+ 处 mock `generateEvent` 回调 → 签名确实未变） |
| core / server `tsc --noEmit` | ✅ 均退出码 0 |
| `core` build | ✅ 退出码 0；**已核 dist 产物含新代码**（`dist/provider/openai.js` 有 `reasoning=` / `EMPTY content`） |
| 实测日志形状 | ✅ `[LLM] m → {"content":"x"} tokens=1200+310=1510 finish=stop reasoning=242 (0ms)`<br>✅ `[LLM] m →  tokens=900+1024=1924 finish=length reasoning=1024` + 空响应 warn |

## ★ 刻意不做（记录在案）

- ❌ **不给 `life.generateEvent` 加 `max_tokens`** —— 本 change 的目的正是**先拿到证据**；
  填什么数字要等探针数据（proposal 决策 4）
- ❌ **不改 `LifeService.generateEvent` 回调签名** —— 会波及 core 类型 + 60+ 处 mock
  （proposal 决策 3）；就地打点信息一样全
- ❌ **不顺手改 `proactive.personalize: 256` / `vision.describe: 200`** —— KI-2 属独立判定
  （但它们的 `finish`/`reasoning` 现在顺带可观测）
- ❌ **不跑真实 API 探针** —— 花钱且属于下一步（采数据），本 change 只保证"采得到"

## 下一步（不在本 change 内）

**采数据 → 决策**：让她正常跑一天，或照 `scripts/verify-session-summary-fix.ts` 的方法论
写探针打一次 `life.generateEvent`，读 `[Life] event LLM` 行的 `finish` / `reasoning` / `content`：

- `finish=length` + `content=0字` → 给该槽显式 `max_tokens`（开**独立 change**，附实测数据）
- `finish=stop` 且数字宽裕 → 在 `memory-system` §4.1.2 记一句「已实测安全」闭环 KI-1
- **顺带**看 `proactive.personalize` / `vision.describe` 两行 → 一并闭环 KI-2

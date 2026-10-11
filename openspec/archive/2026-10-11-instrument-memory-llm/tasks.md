# Tasks: instrument-memory-llm

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## core · 记忆链路 LLM 客户端（唯一观测点）

- [x] `src/modules/resources.ts` `memoryLlmModule.complete()`：
      - 记录 `start = Date.now()`
      - 非 2xx：保持现有 `throw`（含响应体文本），**不改语义**
      - 解析 `choices[0].finish_reason` → `finishReason`
      - 解析 `usage.completion_tokens_details.reasoning_tokens` → `reasoningTokens`
      - 解析 `usage.prompt_tokens` / `completion_tokens` → 日志 `tokens=<in>+<out>=<total>`
      - 成功日志：`[LLM:memory] <model> → <摘要> tokens=.. finish=.. reasoning=.. (..ms)`
      - `content` 为空 → **单独 `logger.warn`**，
        `finish=length` 与 `finish≠length` 给出**不同文案**
- [x] 字段缺失（无 `usage` / 无 `completion_tokens_details` / 无 `finish_reason`）
      → 日志显示 `?`，**不抛不崩**
- [x] 确认 `MemoryManager` 的 `slotify(slot)` 第三参仍然生效（回归，见 spec §4.1.1 契约 3）
- [x] **实现细节**：日志走 `ctx.logger` 而非模块级 `logger` 导入——
      生产环境是同一个对象（`kernel/host.ts:37`），但测试里 `runModule` 会注入
      可断言的 test logger。顺带删掉了因此变为未使用的 `logger` 导入。

## 测试

- [x] 新增观测用例（**并入既有 `packages/core/tests/modules/resources.test.ts` 的
      `al:memory-llm` describe 块**，不另开文件——同模块的用例应当同处）：
      - 正常响应 → `[LLM:memory]` 行含 `finish=` / `reasoning=` / `tokens=`
      - 空 content + `finish_reason='length'` → warn 文案指向「预算耗尽 / max_tokens」
      - 空 content + `finish_reason='stop'` → warn 文案**明确说不是预算问题**
      - 无 `usage` / 无 `completion_tokens_details` → 不抛，显示 `?`
      - 非 2xx → 抛错且错误文本含响应体
- [x] 既有用例全绿（见验收表）
- [x] `tsc --noEmit` 退出码 0

## 文档

- [x] `openspec/specs/memory-system/spec.md`：
      §4.1.2 补「第二个客户端」的限定 + 新增 §4.1.3 契约 5
- [x] `docs/KNOWN-ISSUES.md`：KI-1 的「判定入口」更正为
      「provider `[LLM]` 行（聊天链路）+ `[LLM:memory]` 行（摘要/画像/cron/人格链路）」，
      并写明「缺该行 = 记忆链路全盲」

## Apply 任务（实现完成后）

- [x] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [x] 更新 `openspec/specs/index.md`（`memory-system` 的「最后变更」）
- [x] **core build 说明**：本地无需单独 build —— `packages/server/Dockerfile`
      在**容器内** `pnpm -r build`（只 COPY `src/`），镜像必然含新代码
- [ ] 更新 `docs/HANDOFF.md`
- [ ] 归档 + 更新索引

## 验收结果（2026-10-11）

| 项 | 结果 |
|---|---|
| core 单测（不含 e2e） | ✅ **638 passed / 66 files** |
| 新增观测用例（与 `session-end-window` 合计 2 文件） | ✅ **19 passed**（其中本 change 新增 5 条） |
| `tsc --noEmit` | ✅ 退出码 0 |
| core build | ✅ 由 Dockerfile 在容器内 `pnpm -r build` 完成 |
| 实测日志形状（部署后从服务器确认） | ✅ 部署当天即拿到：<br>`[2026-10-11 10:11:46] [INFO] [LLM:memory] deepseek-v4-flash → {"summary":"昔涟两次向轻月道早安…" tokens=390+1081=1471 finish=stop reasoning=882 (9785ms)`<br>另两条 `{"adjustments":…}`（PersonaAdapter）也可见 |
| ★ 首条数据的意义 | **`reasoning=882` / `output=1081`** —— 一次成功摘要里 **82% 的输出预算花在 reasoning 上**，留给可见内容仅 ~199 tokens。这正是 `decide-life-event-max-tokens` 需要的量级证据 |

## 下一步（不在本 change 内）

部署后采集 `[LLM:memory]` 行，读会话摘要槽的 `finish` / `reasoning` / `content`：

- `finish=length` + 空内容 → 给该槽更大的 `max_tokens`（开独立 change，附实测数字）
- `finish=stop` + 空内容 → 不是预算问题，另查（prompt 组装 / 模型行为）

# Tasks: fix-persona-adapter-json-tolerance

> KI-4。实现已完成并验证，本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`tests/memory/unit/persona-adapter-json.test.ts`
- [x] 复现确认**红**（4 条，原文）：
      ```
      × ★★ 主症：```json 围栏包着的 JSON 必须照常解析（旧实现直接放弃）
        AssertionError: 围栏导致解析失败 ⇒ 人格自适应静默失效（模型包围栏是常见行为）:
          expected null to match object { param: 'tone.formality', …(1) }
      × ★ 前后带空白的围栏也要剥
        AssertionError: expected null to match object { param: 'tone.formality' }
      × ★★ 解析不出来时必须留痕
        AssertionError: 解析失败却一声不响 —— 这正是 KI-4 藏了这么久的原因:
          expected '' to contain 'PersonaAdapter'
      × ★ 模型返回空串 → 同样留痕
        AssertionError: expected '' to contain 'PersonaAdapter'
      4 failed | 3 passed (7)
      ```
- [x] `processSignal` 改用 `parseLLMJson()`（共用解析器，不新写剥围栏逻辑）
- [x] 解析不出来 → `warnThrottled('persona-adapter-json', …)`
- [x] 结构异常（解析成功但 `adjustments` 不是数组）→ `warnThrottled('persona-adapter-shape', …)`
- [x] `adjustments: []` 与字段不合法 → 返回 null **不 warn**（三种"没有调整"分开）

### ⚠️ 过程中自己抓到的一处假通过（记下来）

第一版测试用了 `随便聊聊` / `在的` 当输入 —— 它们**过不了 `processSignal` 开头的信号前置过滤**
（`太+|能不能别|我喜欢|我讨厌|不要|别|更|再`），**根本没走到 LLM**。
⇒ S6/S7 是"因为错误的理由通过"的（空转）。
已把输入改成 `别那么正式`，并在测试文件的辅助函数上写明这条判据。

## 测试

7 例全过（见 proposal 的 S1–S7 表）。

## Apply 任务

- [x] A.1 合并到 `openspec/specs/memory-system/spec.md` §4.1.1 **新增契约 4**
      （"所有 LLM 结构化输出必须走共用解析器 + 解析失败必须留痕"，
      含"当前实现分布"清单，提醒新增消费方照办）
- [x] A.2 更新 `openspec/specs/index.md`（memory-system 行）
- [x] A.3 更新 `docs/KNOWN-ISSUES.md` KI-4 标注
- [x] A.4 运行测试（见下）
- [x] A.5 归档

## 验证记录

| 项 | 命令（workdir `packages/core`） | 结果 |
|---|---|---|
| 定向 | `run tests/memory/unit/persona-adapter-json.test.ts` | **7 passed** |
| core 全套 | `run --exclude='tests/memory/e2e/*'` | **81 files / 777 passed**（含本 change +7） |
| 类型 | `npx tsc --noEmit` | exit 0 |

## 部署状态

**未部署。** 只改 core 代码与 spec。

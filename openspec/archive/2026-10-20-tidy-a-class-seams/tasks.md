# Tasks: tidy-a-class-seams

## A4 scripts 里的提示词

- [x] 4 个记忆提示词导出到 `@alysia/core/memory` barrel（core 不暴露深路径）
- [x] `verify-session-summary-fix.ts`：副本 → `import { SESSION_SUMMARY_SYSTEM_PROMPT }`
- [x] `life-e2e-verify.ts`：标为**故意简化**的诊断变体（别当 bug 修）
- [x] `verify-micro-narrative.ts`：同上
- [x] `show-life-effect.ts`：同上
- [x] `digest-worldbook.ts`：无对应物，不动（在 tasks 里记明原因）

## A3 客户端信封契约

- [x] URL + 两个请求头逐字相同
- [x] 错误文案同形 `LLM API error <status>: <body>`
- [x] 默认超时锁 `120_000`

## 验证

- [x] `tsc` core 构建通过 / server typecheck 通过（含 scripts）
- [x] 契约测试 8 条全绿（原 5 + 新 3）
- [x] 全量（Node 24，免 API）：**139 文件 / 1746 测试全绿**（A1 前是 1739）

## 收尾

- [x] `memory-system` §4.1.4 补契约 7.4；§4.1.5 补 A4 说明
- [x] 归档 + 索引 + HANDOFF
- [x] A 类 ①-④ **全部完成**

## 下一步（B 类，行为必变）

B1 召回加权公式（先补观测）→ B2 两个旋钮召回侧 → B3 收编 ProviderManager →
B4 人格联动 v2 → **B5/B6 等用户拍板**（dsh 两份人格 / 116 条 synthetic 数据）。

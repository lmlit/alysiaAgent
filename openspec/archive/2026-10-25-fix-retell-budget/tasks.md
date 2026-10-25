# Tasks: fix-retell-budget

## 实现

- [x] `sampling.ts`：`life.retell.max_tokens` 512 → **2048**，注释写明 5 连测证据

## 测试

- [x] 新增 `packages/core/tests/provider/retell-sampling.test.ts`（3 例）：
      必须显式有 `max_tokens` / ≥1024 / 温度 0.6–1.0
- [x] 全量 **165 文件 / 1941 用例**（exit 0）

## 部署与验收

- [x] 离线构建 → `deploy.mjs --skip-build`（镜像 8b4a9f9bcfc7，`rollback-20261025-124048`）
- [x] 部署后重跑探针：**2048 两次全成**（512 仍能复现 2/3 空 —— 同一探针里对照）
- [ ] 等下一次真实 tick，确认日志 `retell ok` + `pushed(... via=retell)`（下次事件 13:01 左右）
- [x] 归档到 `openspec/archive/2026-10-25-fix-retell-budget/`

## 明确不做

- ❌ 不碰 `life.generateEvent` 的预算（它缺 `max_tokens`，KI-1 在案；但没有失败证据，另案处理）
- ❌ 不改 prompt 去压推理量

## 验收证据（2026-10-25 12:44，生产容器内对照探针）

同一个探针脚本里同时跑 512 与 2048（**不是换个参数再测**，是同一次对照）：

| max_tokens | finish | reasoning | 正文字数 | 结果 |
|---|---|---|---|---|
| 512 | stop | 402 | 30 | ✅ |
| **512** | **length** | **512** | **0** | ❌ 空响应（就是线上那次） |
| **512** | **length** | **512** | **0** | ❌ |
| 2048 | stop | 387 | 31 | ✅ |
| 2048 | stop | 446 | 29 | ✅ |

⇒ **512 复现 2/3 空**，2048 **2/2 成**。假设-验证闭环，不是"调大试试"。
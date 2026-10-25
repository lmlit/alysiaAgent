# Tasks: fix-retell-budget

## 实现

- [x] `sampling.ts`：`life.retell.max_tokens` 512 → **2048**，注释写明 5 连测证据

## 测试

- [x] 新增 `packages/core/tests/provider/retell-sampling.test.ts`（3 例）：
      必须显式有 `max_tokens` / ≥1024 / 温度 0.6–1.0
- [x] 全量 **165 文件 / 1941 用例**（exit 0）

## 部署与验收

- [ ] 离线构建 → `deploy.mjs --skip-build`
- [ ] 部署后重跑 5 连测：**0 次空响应**
- [ ] 等下一次真实 tick，确认日志 `retell ok` + `pushed(... via=retell)`
- [ ] 归档

## 明确不做

- ❌ 不碰 `life.generateEvent` 的预算（它缺 `max_tokens`，KI-1 在案；但没有失败证据，另案处理）
- ❌ 不改 prompt 去压推理量

# Tasks: record-out-of-band-server-config-change

> **状态：pending**（已登记，尚未开工）。开工前先让用户拍板「进仓库默认值 / 记录为部署覆盖」。

## 待办

- [ ] 用户拍板方向（见 proposal.md「需求」第 1 条）
- [ ] 按方向落地（改 `sampling.ts` 默认值 **或** 写部署差异文档）
- [ ] 把 CHANGELOG 里的实测数字附到 `memory-system` §4.1.1 的预算决策记录
- [ ] 评估 `life.generateSummary` / `profile.deepRewrite`（与 KI-1/KI-2 同族）
- [ ] 复核 `/root/alysia/config.yml` 与仓库的**完整差异**（不止这两个槽位）

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`
- [ ] 更新 `openspec/specs/index.md`
- [ ] 跑 `scripts/check-spec-diff-residue.cjs`

# Tasks: reconcile-stale-todos（纯文档）

## 对账

- [x] 逐条核对 TODO.md 的 ✅ / 在办项与 `openspec/archive/`、代码现状
- [x] 确认 KI-26 已修（`2026-10-16-fix-summary-anchor-floor`）
- [x] 确认 `fix-reflection-insight-misroute` 已部署（修复提交是 10-25 部署的祖先）
- [x] 确认 KI-5 实际余量：2 处（ProfileExtractor/CronProcessor 已改 warn）
- [x] 确认 P6 已落地（`worth-telling-and-silence-clock`）、P7 代码在 HEAD（`9fd017e`）

## 文档

- [x] 重写 `docs/TODO.md`（只留在办 + 销账计数）
- [x] `CLAUDE.md` 测试基线 / Next 指针
- [x] `HANDOFF.md` 顶部加 2026-10-26 段
- [x] `PLAN-2026-10-24-context-and-rules.md` P6/P7
- [x] `KNOWN-ISSUES.md` KI-5 / KI-25 / KI-26
- [x] `SILENT-FAILURE.md` KI-5 / KI-26 / KI-25
- [x] `openspec/specs/index.md`（harden 的 server-hardening 行）

## 验证

- [x] `E:\nodejs24\node.exe scripts/check-spec-diff-residue.cjs` ⇒ exit 0
- [x] 表内所有链接可解析（无死链）
- [x] 归档到 `openspec/archive/2026-10-26-reconcile-stale-todos/`

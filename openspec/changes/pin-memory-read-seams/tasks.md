# Tasks: pin-memory-read-seams

> code review 遗留四项（F11 / F7 / F3 / F5）。见 `proposal.md`。

## 实现任务

- [x] **F11** `packages/core/src/memory/index.ts`：导出
      `AssembleOptions` / `AssembleReport` / `ChatBlockKey` / `CodeBlockKey`（type）
      与 `CHAT_BLOCK_POLICY` / `CODE_BLOCK_POLICY` / `worldbookSkipDiagnosis`（值）
- [x] **F7** `PromptAssembler.ts`：新增纯函数 `worldbookSkipDiagnosis(triggers, scope)`，
      分类计数（image 型 / scope 不符 / 两类并存）+ 各自的处置提示；守卫改为调它
- [x] **F3** `packages/server/src/webui/server.ts`：`/api/memory/read` 日志在
      `blocks='chat'` 且无 `worldbookScope` 时追加 `未给 worldbookScope ⇒ 世界书不注入`
- [x] **F5** **不改行为**：顺序是有记录的权衡（见 `CHAT_BLOCK_POLICY` 注释），改为测试钉住
- [x] spec `memory-system` 新增契约 6（顺序与导出面）/ 契约 7（0 条注入的诊断）

## 测试任务

- [x] 新增 `packages/core/tests/memory/unit/pin-memory-read-seams.test.ts`（8 例）
- [x] **反向自检**：第一版用 `vi.spyOn(warnThrottled)` 断言文案 → 第二个用例拿到空串
      （`warnThrottled` 有限频）⇒ 证明"内联文案测不了"，据此才改成纯函数
- [x] 全量 **163 文件 / 1919 用例**（Node 24）

## Apply / 部署任务

- [x] 合并 spec 改动（`memory-system` 契约 6/7）
- [ ] 运行 `node scripts/check-spec-diff-residue.cjs`（非 0 不许归档）
- [ ] 更新 `openspec/specs/index.md`（memory-system 行）
- [ ] **按新流程部署**：`pnpm deploy`（Step 0 全绿 → 构建 → 打回滚标签 → 切换 → 健康检查）
- [ ] 部署输出记进本文件（`docker ps` + `/api/health`）——**那才是验收依据**
- [ ] 归档到 `openspec/archive/YYYY-MM-DD-pin-memory-read-seams/`

## 明确不做

- ❌ 不改 `CHAT_BLOCK_POLICY` 的顺序（F5）：没有运行数据就动优先级 = 拍脑袋
- ❌ 不给 `blocks='chat'` 自动补 `worldbookScope`（F3 的另一种解法）：那是**行为变更**，
  会改变 console 预览的注入量；先让日志说清，等真实需要再单独开 change

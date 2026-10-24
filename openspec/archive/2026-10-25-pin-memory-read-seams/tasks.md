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
- [x] 运行 `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`（memory-system 行）
- [x] **按新流程部署**：`node scripts/deploy.mjs`（Step 0 全绿 → 构建 → 打回滚标签 → 切换 → 健康检查）
- [x] 部署输出记进本文件（见下）——**那才是验收依据**
- [x] 归档到 `openspec/archive/2026-10-25-pin-memory-read-seams/`

## 明确不做

- ❌ 不改 `CHAT_BLOCK_POLICY` 的顺序（F5）：没有运行数据就动优先级 = 拍脑袋
- ❌ 不给 `blocks='chat'` 自动补 `worldbookScope`（F3 的另一种解法）：那是**行为变更**，
  会改变 console 预览的注入量；先让日志说清，等真实需要再单独开 change

## 部署验收证据（2026-10-25 01:43，`node scripts/deploy.mjs`）

```
▸ Step 0b 全量测试  ✓ 全绿
▸ Step 1 config 漂移检查  ✓ 与服务器一致
▸ Step 3 构建镜像  ✓ server-alysia:latest → f740d3454928
▸ Step 4 打包 + 上传  ✓ 125.5 MB
▸ Step 5 部署  rollback-tag=server-alysia:rollback-20261025-014352
              health[1]=200  OK
▸ 部署成功     alysia-server Up 6 seconds → 之后 Up 1 minute (healthy)
              {"status":"ok","uptime":...}
```

产物校验（容器内）：`dist/memory/PromptAssembler.js` 含 `worldbookSkipDiagnosis` = **2** 处，
`dist/memory/index.js` = **1** 处 ⇒ 新函数与 barrel 导出都在镜像里。

★ 部署过程本身踩到两个环境坑（都不是代码问题）：
1. 我改根 `package.json`（加 deploy 脚本）**失效了 docker 的 install 层缓存** ⇒ 容器内要联网
   `pnpm install`，直连 npmmirror 报 `ECONNRESET`；
2. Clash 只监听 `127.0.0.1:7897`，容器经 `host.docker.internal` 打过来是 refused ⇒
   需要 `0.0.0.0:7898 → 127.0.0.1:7897` 转发；且当时 mihomo 进程活着但**没监听任何端口**（僵尸），
   重新拉起后才恢复。
   ⇒ 脚本已支持 `ALYSIA_BUILD_PROXY`（传 `--build-arg HTTP(S)_PROXY`）。
# Tasks: assembler-block-registry

> P8 第 2 步。**零行为变更**，证明标准 = characterization 快照逐字不变。见 `proposal.md`。

## 实现任务

- [x] 新增 `packages/core/src/memory/block-registry.ts`：
      `BlockSpec{key,policy,effect,source,note?}` + `CHAT_BLOCKS`(13) + `CODE_BLOCKS`(6)
- [x] `CHAT_BLOCK_POLICY` / `CODE_BLOCK_POLICY` 由注册表**派生**（`toPolicy()`）
- [x] 导出 `CHAT_BLOCK_ORDER` / `CODE_BLOCK_ORDER` / `WRITE_EFFECT_CHAT_BLOCKS`
- [x] `PromptAssembler.ts` 改为 re-export（删掉手写的两张策略表与 `ChatBlockKey` 联合类型）
- [x] `memory/index.ts` 公开注册表本体
- [x] spec `memory-system` 契约 8

## 测试任务

- [x] **characterization 快照 4/4 通过**（未 `-u`；这就是"零行为变更"的证据）
- [x] 新增 `block-registry.test.ts`（10 例），含反向约束：
      ① key 全覆盖、无重复；② 策略派生一致；③ `required` 只有三个；
      ④ `source` 非空；⑤ ★ `WRITE_EFFECT_CHAT_BLOCKS` 只有 `pendingConfirm`，
         且它的 `note` **必须**写明 `expireStaleFacts/writeFacts`；⑥ code 表全纯读
- [x] 全量 **164 文件 / 1929 用例**

## Apply / 部署任务

- [x] 合并 spec（`memory-system` 契约 8）
- [x] `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`
- [x] 部署：`node scripts/deploy.mjs`（含 `ALYSIA_BUILD_PROXY`，构建期需联网）
- [x] 部署输出记进本文件（见下）
- [x] 归档到 `openspec/archive/2026-10-25-assembler-block-registry/`

## 明确不做

- ❌ 不改 `assembleChat()` 函数体（"真正的拆块"风险高，另开 change）
- ❌ 不改掉 `pendingConfirm` 的写副作用：那要动 `listPendingConfirmFacts()` 的语义与过期清理时机，
      属行为变更 —— **先显式化，再决定要不要动**

## 部署验收证据（2026-10-25 02:10，`node scripts/deploy.mjs`）

```
Step 0b 全量测试     ✓ exit 0（164 文件 / 1929 用例）
Step 1  config 漂移  ✓ 与服务器一致
Step 3  构建镜像     ✓ 0a5c342346ee
Step 4  上传         ✓ 125.5 MB
Step 5  部署         rollback-tag=server-alysia:rollback-20261025-021012
                     health[1]=200  OK
部署成功             alysia-server Up (healthy) · {"status":"ok"}
```

产物校验（容器内）：`/app/packages/core/dist/memory/block-registry.js` 存在，
含 `WRITE_EFFECT_CHAT_BLOCKS` 1 处 ⇒ 注册表已进镜像。

★ 本轮又修掉一个**部署脚本自己的**缺陷：Step 0b 原来按输出文本判断"测试过没过"，
而 vitest 的 stderr 里塞满测试日志 ⇒ **测试全绿却把部署拦下**。现在只看退出码。
（两次部署中断都是它，不是代码问题。）
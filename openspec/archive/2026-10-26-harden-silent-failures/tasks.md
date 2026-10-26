# Tasks: harden-silent-failures

> 2026-10-26 范围收缩：只做 KI-5 的两处（QQ 适配器）+ 机器闸。
> KI-26 已由 `fix-summary-anchor-floor` 修复；KI-25 因 `bridge: false` 休眠，移到 `docs/TODO.md`。

## 实现

- [x] `qq-official.ts`：新增 `handleFramePayload(raw, stage)`，替换两处裸 catch
- [x] 坏帧不抛、warn 带阶段/字节数/次数/原因；前 3 次逐条，之后每 100 次一条
- [x] 新增 `scripts/check-bare-catch.cjs`（真·空 catch ⇒ exit 1；注释说明过的不拦）
- [x] 接进 `scripts/git-hooks/pre-commit` 第 ④ 段
- [x] `package.json` 增加 `check:bare-catch`
- [x] spec：`server-hardening` 新增 §8（四条契约）

## 测试

- [x] `qq-official.test.ts` +2 条（非法 JSON 不抛且 warn；连续坏帧前 3 次逐条）
- [x] 单文件：`11 passed`
- [x] 机器闸自检：临时注入一处真·空 catch ⇒ exit 1；删除后 ⇒ exit 0
- [x] 全量测试（Node 24）：**171 文件 / 1998 用例全绿**

## 归档

- [x] 更新 `openspec/specs/index.md`（server-hardening 行）
- [x] `docs/TODO.md` / `docs/KNOWN-ISSUES.md` / `docs/SILENT-FAILURE.md` 销账 KI-5
- [x] 归档到 `openspec/archive/2026-10-26-harden-silent-failures/`

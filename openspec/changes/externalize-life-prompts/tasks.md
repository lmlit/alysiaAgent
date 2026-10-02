# Tasks: externalize-life-prompts

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 搬运（脚本化，不手抄）

- [x] 写一次性脚本：按**文本切片**从 `modules/life.ts` 切出提示词常量块
- [x] 脚本内断言：加/去 `export ` 前缀后与源**逐字符相等**，不通过不落盘
- [x] 生成 `src/prompts/life.ts`（5 段，6431 字节）
- [x] 重接线 `modules/life.ts`：删常量块 + 加 import；脚本内断言
      「5 个常量都被引用、原提示词文本不再出现在该文件」
- [x] 删除两个一次性脚本

## 文档

- [x] `src/prompts/README.md`：资产表 + **为什么不是 `.md`**（三条理由）+ **何时该回头做**（三条判据）
- [x] `modules/life.ts` 文件头注释更新（原写「P4 会外置」，已过时）

## 测试

- [x] `tests/prompts.test.ts`（7 用例）
      - 五段都在、非空、非截断、无首尾空白
      - ★ 要 JSON 的三段必须含 `"json"`（API 硬约束）
      - ★ **纯文本两段不得要求 JSON**（反向守卫）
      - 各段关键标记：事件生成（生活切片/时辰/真实感/agency/next_in_hours）、
        摘要（50 字/第一人称/不要 JSON）、承诺裁决（三选一/delay_hours/绝不静默消失）、
        反思（reflection/adjustments/insight/诚实优先）

## 不做（有意偏离，理由见 proposal）

- [x] ~~外置成 `.md` + loader~~ → 与「逐字不变」冲突，且新增构建/路径故障面；
      判据写进 `prompts/README.md`，满足条件时再回头做

## Apply 任务

- [x] `openspec/specs/ai-life-system/spec.md` 补提示词资产位置
- [x] `openspec/specs/index.md` 更新
- [ ] `docs/HANDOFF.md`：P4 完成

## 验收结果（2026-10-01）

| 项 | 改造前 | 改造后 |
|---|---|---|
| 常规全仓 | 848 | ✅ **855**（+7 提示词守卫） |
| E2E（真 API） | 5/5 | ✅ **5/5** |
| core / server tsc | — | ✅ 均退出码 0 |
| **真启动** | 起来 | ✅ 起来，`13/13` + `10/10` |
| 启动日志 | 基准 | ✅ **逐行相同** |
| `/api/life` | 14998 B | ✅ **14998 B** |
| `/api/profile` | 42752 B | ✅ **42752 B** |
| `modules/life.ts` | 200+ 行 | **133 行** |

**提示词内容一致性**：由搬运脚本的逐字符断言保证（不通过不落盘），
不是靠人眼比对——这是本次搬运唯一可能引入静默劣化的地方。

# Tasks: retell-events-in-her-voice

> 推送前再过一轮模型，**以她的视角讲给你听**。见 `proposal.md`。

## 实现任务

- [x] `prompts/life.ts`：`LIFE_RETELL_PROMPT`（1-2 句 / ≤50 字 / 第二人称 / 一个具体细节 /
      不写动作与环境 / 语气词·♪·反问 合计最多一处 / 只讲发生过的事）
- [x] `sampling.ts`：`life.retell` 槽（`temperature 0.85`, **`max_tokens 512`**）+ 类型 + 深合并
- [x] `life.ts`：`spokenText()` 三层降级（retell → 校验过的 message → **不推**），**绝不回落 content**
- [x] `life.ts`：`retellForUser()`（上下文：此刻时间 + 刚做的事 + 当时想说的话 + 关系现状）
- [x] `life.ts`：`checkRetell()`（空 / >70 字 / 抄叙述 / `*动作*` / `（动作）` / markdown）
- [x] `modules/life.ts`：注入 `retellEvent`（独立 sessionId `life-retell` + 预算现场日志）
- [x] 推送日志加 `via=`（能看出走的是转述还是 message）

## 测试任务

- [x] `life-service.test.ts` 85 例全绿，含：
      ★ 走转述并校验输入 · ★ 无 message 无转述则不推 · ★ 转述超长判不合格 ·
      ★ 无生成器但 message 合格仍推
- [x] 原用例「chat 事件无 message → 回落推 content（兼容旧行为）」**按行为变更重写**
      （那正是用户抱怨的机制根因，不能留）
- [x] 既有 4 处 chat fixture 补 `message`（chat 事件本该带）
- [x] 全量 **165 文件 / 1938 用例**

## Apply / 部署 / 验收

- [ ] `check-spec-diff-residue.cjs`
- [ ] spec `ai-life-system` 补"两段式"契约；`specs/index.md`、`docs/TODO.md`
- [ ] 部署（注意：本轮构建需走离线姿势，见 `deploy.mjs --skip-build`）
- [ ] **生产验收**：日志出现 `[Life] retell ok (N字)` 与
      `[Life] pushed(…, via=retell, …)`；且 `via=message` 只在无生成器时出现
- [ ] 归档

## 明确不做

- ❌ 不改 `postCheck` 的 content 校验（那套仍有效，只是不再管推送文本）
- ❌ 不把转述再走一遍聊天管线（会话/记忆耦合太重，且会污染对话）

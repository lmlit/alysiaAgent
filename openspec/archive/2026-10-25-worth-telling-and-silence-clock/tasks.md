# Tasks: worth-telling-and-silence-clock

> whale 对照出的两个缺口（有配额、没判断 / 沉默时钟太慢）。见 `proposal.md`。

## A. 值不值得说
- [x] `LIFE_RETELL_PROMPT` 改输出 JSON `{worth, why, say}` + 判据（含"安静也是一种表达"）
- [x] `life.ts`：`parseRetellJSON()`（容忍围栏/前后杂字；解析不了 = 不合格 = 不推）
- [x] `life.ts`：`worth=false` ⇒ 不推 + 日志记理由
- [x] `modules/life.ts`：`responseFormat: 'json'`

## C. 表态时钟
- [x] `context-facts.ts`：纯函数 `silenceCap()` + 常量（3/7 天，可覆盖）
- [x] `life.ts`：推送门三处取 min；**真正生效时打日志**
- [x] `life.ts` opts：`silenceQuietDays` / `silenceMuteDays`

## ★ 被测试抓出的 bug
- [x] 第一版用了 `idleDaysSinceUserMessage()`（显示包装，null→999）⇒「从没说过话」被当
      「沉默 999 天」⇒ 推送被掐死。改用 `idleSinceLastUserMessage()`
- [x] 加反向用例：`null` ⇒ **不受影响**

## 测试
- [x] `silence-clock.test.ts` 6 例（纯函数边界 / 非法值 / 可覆盖）
- [x] `life-service.test.ts` +6 例（接线）；修 4 处 retell 桩为 JSON；+2 例（worth=false / 非 JSON）
- [x] 全量 **167 文件 / 1955 用例**

## 部署与验收
- [x] 离线构建 → `deploy.mjs --skip-build`（镜像 d4a06a4b249e，`rollback-20261025-164856`）
- [x] 验收①：生产探针 —— 返回合法 JSON，worth/why/say 齐全（见下）
- [x] 验收②：当前 idle=0 ⇒ 日志**无** `silence cap` 行（符合"只在生效时留痕"）
- [x] 归档到 `openspec/archive/2026-10-25-worth-telling-and-silence-clock/`

## 明确不做
- ❌ 不动亲密度衰减速率（那是"关系温度"，另一件事）
- ❌ 不照抄 whale 的 3/7 天
## 生产验收证据（2026-10-25 16:52，容器内实跑生产 prompt）

**A. 值得说（真实事件 3 条）** —— 都判 `worth=true`，说法 23–34 字、带一个问句：

| 事件（她的日记） | why | say |
|---|---|---|
| 新米入缸、看米面平整 | 有具体细节，可以顺带问他一句 | 「新米装缸了，我按了按，指腹上沾了几粒。你晚上想喝粥吗？」(27 字) |
| 灯芯捻短、空布袋摊在桌角 | 刚对他说过的话，这会儿静下来有点不好意思 | 「刚才那句天天都想着你，说完没觉得，这会儿静下来倒有点脸热。你睡了吗？」(34 字) |
| 晌午煮了新米饭 | 有具体细节，还能问他要不要回来吃 | 「这回水放得少，是正经的饭不是粥啦，你回来吃吗？」(23 字) |

**B. 不值得说（负向路径，用平凡琐事试）** —— 真的会说"不值得"：

| 事 | worth | why |
|---|---|---|
| 把碗洗了、擦灶台、晾抹布 | **false** | 日常家务流水，没有具体话头 |
| 蹲在门口系鞋带，系了两遍 | **false** | 太琐碎，没有具体可聊的内容 |

⇒ 「值不值得说」不是又一条配额，它真的会因为她觉得"没必要"而不发。

**C. 表态时钟**：当前 idle=0（他今天说过话）⇒ 日志里**没有** `silence cap` 行 ——
符合设计（只在真正压低额度时留痕）。
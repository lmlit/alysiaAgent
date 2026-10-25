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
- [ ] 离线构建 → `deploy.mjs --skip-build`
- [ ] 验收①：生产跑一次转述探针，**返回 JSON 且含 worth/why/say**
- [ ] 验收②：`silence cap` 日志只在约束生效时出现（当前 idle=0，应**不出现**）
- [ ] 归档

## 明确不做
- ❌ 不动亲密度衰减速率（那是"关系温度"，另一件事）
- ❌ 不照抄 whale 的 3/7 天
# Tasks: prove-intimacy-decay-reachable

> 核心不是"改代码"，是**证明它能触发**。方案见 `proposal.md`。
> 本 change **不动任何系数**（阈值 8 天 / 衰减 1.8/天 / 四档边界全部保留）。

## 实现任务

- [x] **判据换源**：`life.ts` 新增 `idleSinceLastUserMessage(): number | null`（**唯一出处**），
      用 `getLastUserMessageAt()`（全表 SQL，无窗口）；删掉
      `getRecentMessages(sid, 500, since7d)` 里 `reverse().find(role==='user')` 那段
- [x] **干掉哨兵**：`null` = 库里无真人消息 ⇒ **不衰减** + 每个实例只打一次 debug
      （旧实现 `: 7` 正好卡在阈值 8 之下 —— 用哨兵参与运算正是那个 bug 的形态）
- [x] **与推送闸同源**：`idleDaysSinceUserMessage()` 改为 `idleSinceLastUserMessage()` 的**显示版**
      （`null → 999` 仅用于档位展示，注释写明"不是真实天数"）
- [x] **留痕**：衰减发生时日志带 `idle / threshold / perDay / freqScore`
- [x] **spec**：`ai-life-system` §11 补「idle 判据」+ **§11.0 可达性契约**

## 测试任务

- [x] **跨阈值三点**（`life-service.test.ts` 「亲密度衰减 —— 可达性（跨阈值）」）：
      `idle=7` 不衰减（40.714）/ `idle=8` 衰减 1.8（39.292，差值 1.422）/ `idle=30` freqScore 夹到 0（36.518）
- [x] **哨兵**：`getLastUserMessageAt() → null` ⇒ 不衰减（40.714），且**不拿 7 冒充**
- [x] **同源**：衰减侧与档位侧取到同一个值（同一 mock 下都是 8）
- [x] **旧用例变真**：原来那两条（5 天 / 今天）现在**显式 mock `getLastUserMessageAt`**，
      不再靠"窗口里没查到"偶然通过
- [x] 回归：全量 **157 文件 / 1868 用例**全过（Node 24）
- [x] **★ 反向自检（已执行）**：临时注入 `__IDLE_FORCE_7__`（模拟旧 bug 的窗口上限 7）⇒
      **3 条用例变红**（idle=8 / idle=30 / 同源），idle=7 与 null 仍绿；随后**删除后门**
      （已验证 `grep __IDLE_FORCE_7__` 为空）
      → 证明这组用例**真能抓到不可达**，而不是又写了一组只守一侧的测试

## Apply 任务

- [x] 合并 spec 改动（`ai-life-system` §11 + §11.0）
- [x] 运行全量测试（Node 24）→ 1868 全过
- [x] 运行 `node scripts/check-spec-diff-residue.cjs`（exit 0）
- [x] 更新 `openspec/specs/index.md`（ai-life-system 行「最后变更」）
- [x] 更新 `docs/PROMPT-INVENTORY.md` §4「多久没说话」那行（两份判据 → 已收敛）
- [x] `docs/PLAN-2026-10-24` 的 **P2/P3** 两行改状态 + §2.1/§2.2 补查证结论
- [x] 更新 `docs/TODO.md` 对应行
- [ ] 归档到 `openspec/archive/YYYY-MM-DD-prove-intimacy-decay-reachable/`

## 明确不做

- ❌ 不调阈值 / 衰减幅度 / 四档边界 —— 没有运行数据（见 proposal §设计决策）
- ❌ 不做 `context-facts.ts` 结构收敛 —— 那是 P8 第 1 步；本 change 只做到"同源"
- ❌ 不修 idle 的其他消费者（`proactive.contextSnippet` 等）—— 属 P8 范围

## 上线预期（写给未来的自己）

修好之后**她会真的开始衰减**：长期不说话的账号，亲密度从 30 起按 1.8/天 往下掉（下限 10）。
上线后第一次 tick 就能看到明显下降 —— **这是设计行为，不是回归。**

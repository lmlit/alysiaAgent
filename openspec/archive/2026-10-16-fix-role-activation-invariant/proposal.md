# Change Proposal: fix-role-activation-invariant

## 元信息

- **日期**: 2026-10-16
- **类型**: FIX（在**写入侧**建立「最多一个激活角色」的不变量）
- **状态**: **archived**（2026-10-16 完成 propose → apply → archive；未部署）
- **影响 spec**: `role-system` §2.3
- **来源**: 修复计划「第三批」的「角色激活」项；`docs/KNOWN-ISSUES.md` **KI-22**
  （同 `docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md` **#19**）

## 这条要解决什么

**`PersonaStore.upsertRole` 激活新角色时不清旧主动行** —— 会留下**双激活行**。

```ts
// 旧写法：只置位、不清别人
is_active = CASE WHEN ? = 1 THEN 1 ELSE is_active END
```

而同文件的 `setActive()` **写对了**（事务内先 `SET is_active = 0 WHERE is_active = 1` 再置位）。
两条路径**语义分叉**，且分叉的方向是**不安全**的那一侧。

**为什么它危险**（不是"多一行而已"）：

- 8 个写点（`updateTone` / `updateMemoryConfig` / `addAdaptationHint` / `appendOverlayNote` /
  `setName` / `updateSystemPrompt` / `updateSpeechStyle` / `updateEmotionalRange`）都是
  `UPDATE persona … WHERE is_active = 1`，**无 `LIMIT 1`**；
- `get()` 是 `SELECT * FROM persona WHERE is_active = 1 LIMIT 1`，**无 `ORDER BY`**。

⇒ 双激活时**读与写分叉且不可预测**：人格演化（tone / hints / overlay / memory_config）
**同时写进两个角色**，而读**只认不确定的一行**。
症状是「人格改了没生效 / 随机漂移」，**很难查**（KI-22 原文的判断）。

**为什么此前没爆（这是本项最值得记的一点）**：`upsertRole` 全仓**只有一个调用方**
`MemoryManager.importRole`，而它在同一个函数里、约 50 行后紧跟 `setActive(pkg.role)`，
**中间全是同步代码**（worldbook 的 digest 读 / delete / insert，无 `await`）
⇒ 双激活窗口在**同一 tick 内**被"顺手"修好，外部观测不到。

⚠️ **那个"修好"靠的是调用顺序，不是任何不变量** —— `PersonaStore` 本身不保证它。
所以它是**潜伏的 API 契约缺陷**，风险来源是**下一个调用方**。

## 需求（做什么）

- [ ] **R1**：`upsertRole(..., is_active: true)` 必须与 `setActive` **同语义** ——
      同事务内**先清所有主动行、再置位目标行**
- [ ] **R2**：新建行一律先插 `is_active = 0`，激活统一由 R1 那两行负责
      （避免"插入时置位"与"事务内先清后置"两处语义分叉）
- [ ] **R3**：`get()` 加 `ORDER BY id` —— 让读在**历史脏数据**下也**确定**
      （兜底，不是不变量本身）
- [ ] **R4**：`is_active` 不传 / `false` 时**不得**改动现有激活状态
- [ ] **R5**：建/改与激活在**同一事务**里完成，中途抛错整体回滚

## 设计决策（怎么做，含备选与取舍）

### D1 把不变量建在**写入侧**，读侧只做兜底

KI-22 的建议方向原文就是「更稳的做法是双激活在写入侧就不可能产生，读侧加 ORDER BY 只是兜底」。
本 change 照此办理：`upsertRole` 走先清后置；`get()` 加 `ORDER BY id`。

**被否决：给 8 个写点各加 `LIMIT 1`。** 那是在"允许双激活存在"的前提下打补丁，
改 8 处而只治症状 —— 而且 `LIMIT 1` 在 `UPDATE` 里的取舍同样是**不确定的**
（哪个角色被改？仍然没人回答）。**不变量比补丁好。**

### D2 不在本 change 加"启动时清理历史双激活行"

当前线上**没有**双激活行（KI-22 的核验结论：窗口在同一 tick 内被修好，
外部观测不到）。凭空加一段"修复历史数据"的迁移属于**没有证据的改动**，
且它一旦误判会把正常角色清掉。**若将来实测到，再单独立案。**

## 对账方向确认

- [x] 与现有 spec 冲突？——§2.3 只写了「切换角色 = 事务里清旧 + 设新」，
      **未声明** `upsertRole` 也要遵守它。本 change **补契约**（把不变量写清）。
- [x] 方向判断：**缺陷**（行为与 §2.3 自己声明的语义不一致）⇒ **改 impl + 补 doc**。
- [x] 涉及 Web API？——**不涉及**（`upsertRole` 走 `importRole`，Web 的角色导入间接使用；
      行为变更见下）。
- [x] **登记重复说明**：本项与 `CODE_REVIEW_FIX_PLAN-2026-08-29.md` **#19** 是同一条。
      该表整体已过期（状态列全 ☐），但**本条的两个位置与描述仍然成立**，故照做。

## 测试计划

落点：`packages/core/tests/memory/unit/PersonaStore.test.ts`。

| 编号 | 场景 | 验收 |
|---|---|---|
| R1 | **主症**：默认角色 active 时 `upsertRole(..., is_active: true)` | 激活行**只有**新角色（旧实现：`['alysia','r-extra']`） |
| R2 | 已存在的角色被激活（走 UPDATE 分支） | 同样只剩一个激活行 |
| R3 | `is_active` 不传 / `false` | 现有激活状态**不变**（别把不激活也清了） |
| R4 | 守卫：直接造双激活脏数据 | `get()` 5 次返回**同一**角色（`ORDER BY id`） |
| R5 | 回归 | 既有 `upsertRole` / `setActive` / `listAll` 用例继续通过 |

## ⚠️ 动手前的提醒

- **R4 是守卫不是复现**：SQLite 对简单扫描通常按 rowid 返回，
  所以旧代码（无 `ORDER BY`）在它上面**也可能碰巧通过**。已在测试里注明。
- **别顺手改 8 个写点**（见 D1 的否决理由）——改动面越大，越难证明不变量成立。

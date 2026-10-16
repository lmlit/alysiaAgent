# Tasks: fix-summary-anchor-floor

> 实现已完成并验证。**过程中我推翻了自己一次**（先做了"有界的从头摘"、跑通 757 绿，
> 随后判定上限防的是已不存在的问题、代价却是真丢失 —— 见 proposal D3）。本文件据实结算。

## 实现任务

- [x] 先写复现测试（TDD 红）：`packages/core/tests/memory/summary-anchor-floor.test.ts`
- [x] 复现确认**红**（原文）：
      ```
      × ★★ 主症：消息都是 3 天前、且从未摘要过 → **必须**产出摘要与画像
        AssertionError: 会话结束得太晚（消息全部早于 now−24h）⇒ 一条摘要都没生成，
          这批消息永久进不了记忆: expected 0 to be greater than 0
      × ★ 同一个会话里，跨过 24h 线的那段**也要**摘进去（不能只摘最近一天）
        AssertionError: 只摘了最近的，早于 24h 的那段被丢了:
          expected '[用户] 刚刚说：今天在看生命周期…' to contain '我在学 Rust'
      2 failed | 3 passed (5)
      ```
      ★ 第二条是最刺眼的证据：**同一会话内部**被硬生生截断，只摘了最近一段。
- [x] `EventStore.getEarliestCreatedAt(sessionId)`：`MIN(created_at)`
      （取**全部**事件类型的最小值 —— 放宽只会让窗口更靠前、更完整）
- [x] `summaryAnchor()` 重写：
      - **无会话记录** → 最早事件 **− 1ms**（R1/R2）
      - **有会话记录 + `ended_at` 有值** → `ended_at`（R3）
      - **有会话记录 + `ended_at` 空** → **仍是 24h**（R4，不跟着放宽）
      - **一条事件都没有** → 旧兜底 24h（行为不变）
- [x] 三条入口（`onSessionEnd` / `extractProfile` / `archiveStaleSessions`）仍**共用这一处**
      （R5；2026-10-11 的教训就是"三个入口各写一份"）
- [x] 刻意修订两条事故守卫测试（R6）：
      `session-end-window.test.ts` 的「无历史摘要 → 回退 24h」两条
      → 改为「**从头摘**」，并在原地写清**为什么原来那样写、为什么现在这样改**
- [x] 新增 S7（R7）：**摘过一次 → 第二次绝不重摘**（事故形态不会复发）

### ⚠️ 过程中踩到的坑（两个都值得记）

1. **排他下界吃掉第一条**：第一版把下界设成「最早事件自己的时间戳」，
   而窗口是 `created_at > since` ⇒ **第一条正好被排除**
   ⇒ 新鲜会话因此**一条摘要都不产**（红测当场抓到）。
   ⇒ 最终**减 1ms**。
2. **`ended_at` 为空的分支被我顺手放宽了**：改成 7 天后，
   我自己写的 S4（保守）立刻变红 —— 那个分支**没有已知边界**，
   窗口放宽多少就可能重摘多少。⇒ 收回，**保持 24h**。

## 测试

| 编号 | 落点 | 覆盖 |
|---|---|---|
| S1/S2 | `summary-anchor-floor.test.ts` | 主症（3 天前必摘）+ 同一会话跨 24h 线不截断 |
| S3 | 同上 | 有历史摘要 → 只摘 `ended_at` 之后（**不重摘**） |
| S4 | 同上 | `ended_at` 空 → 保守，不重摘整段历史 |
| S5 | 同上 | 新鲜会话行为不变 |
| S6 | 同上 | 10 天前 + 从未摘要 → **也摘**（不设时间上限） |
| S7 | 同上 | **★ 摘过一次后第二次绝不重摘**（事故不复发） |
| S8 | `session-end-window.test.ts`（修订） | cron 与 session-end **同规则** |
| S9 | 真实 e2e（**用例未改**） | `cron` / `real-api` 转绿 |

## Apply 任务

- [x] A.1 合并到 `openspec/specs/memory-system/spec.md` **§5.4.1 契约 4c**
- [x] A.2 更新 `openspec/specs/index.md`
- [x] A.3 更新 `docs/KNOWN-ISSUES.md` **KI-26**（标注已修 + 记录 D1/D3 的判断）
- [x] A.4 运行测试（见下）
- [x] A.5 归档
- [x] A.6 记录部署状态

## 验证记录

| 套件 | 命令（workdir） | 结果 |
|---|---|---|
| 锚点定向 | `run tests/memory/summary-anchor-floor.test.ts tests/memory/session-end-window.test.ts`（`packages/core`） | **18 passed** |
| core 全套 | `run --exclude='tests/memory/e2e/*'`（`packages/core`） | **77 files / 757 passed**（本 change 前 76 / 750） |
| **真实 E2E** | `run tests/memory/e2e/`（`packages/core`，先导出 `.env`） | **4 files / 5 passed** ⭐ |
| 类型 | `npx tsc --noEmit`（`packages/core`） | exit 0 |

⭐ **E2E 用例一行没改**就转绿 —— 这是本 change 的**验收动作**
（此前 `cron` / `real-api` 各挂 1 条：`basics` 没被重写、facts 一条没提出来）。
耗时：`real-api` 13.2s、`cron` 17.2s（真 DeepSeek + 智谱）。

## 行为变更披露

1. **从未摘要过的会话**现在会**从头**摘要（此前只摘最近 24h）。
   ⇒ 这类会话的首次摘要**窗口可能很大**（受 `LIMIT 1000` 约束）。
   若该窗口导致摘要槽失败，会写成 **`summary_status='failed'`**（可见）
   并由 `retryFailedSummaries()` 补 —— **不会静默**。
2. e2e 里那两条"会话结束得太晚"的用例现在**通过**（此前一直挂，属 KI-26 的现象）。

## 部署状态

**未部署。** 只改代码与契约；未构建镜像、未重启服务、未碰线上数据
（e2e 用 `:memory:` + 临时目录；`.env` 只用于导出变量，未读取内容）。

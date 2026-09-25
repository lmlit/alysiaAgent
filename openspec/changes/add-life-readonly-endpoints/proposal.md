# Change Proposal: add-life-readonly-endpoints

## 元信息

- **日期**: 2026-09-25
- **类型**: NEW（补契约缺口）
- **状态**: in_progress
- **影响 spec**: `alysia-console`（§5 页面契约）、`ai-life-system`（补只读出口）
- **关联**: `adopt-nextjs-console` 实施时登记的两个「未接入」缺口

## 动机（为什么做）

收编新前端时发现两块数据**core 有方法、但没有路由**，页面只能标「未接入」：

| 数据 | core 方法 | 状态 |
|---|---|---|
| 每日生活摘要 | `MemoryManager.listLifeSummaries(days)` | 公开，**无路由** |
| 配角在场状态 | `MemoryManager.listScenePresence()` | 公开，**无路由** |

两者都符合 `docs/Web-API-Design.md` §0 的约束（已在 MemoryManager 暴露公开方法、返回纯数据），
差的只是 Web 路由层的薄包装。补上后 console 的「每日生活摘要」「她的世界」两栏立刻有内容。

## 需求（做什么）

- [ ] `GET /api/life/summaries` → `{ summaries: [{date, summary}] }`
- [ ] `GET /api/life/companions` → `{ companions: [{name, status, basis?, updatedAt}] }`
- [ ] `docs/Web-API-Design.md` 登记两个端点
- [ ] console：`lifeApi.summaries()` / `lifeApi.companions()` + 类型 + 适配
- [ ] console：`/life` 两个区块、`/dashboard` 一个区块从 `NotWired` 换成真实数据
- [ ] 测试：server 路由测试 + console 适配测试

## 设计决策（怎么做，含备选与取舍）

**决策 1：两个独立端点，不塞进 `/api/life`**

备选是给现有的 `/api/life`（已返回 `snapshot` + `events`）加两个字段。否决：摘要与配角
**刷新频率与语义都不同**（配角的在场/离场是独立状态机），塞进一个 payload 会让
`/api/life` 承担所有生活域数据，后续每加一块都要动它。

**决策 2：days 固定 7，不给查询参数**

与 `/api/life` 的 7 天窗口保持一致，避免出现"摘要 30 天 / 事件 7 天"的错位。
需要可配时再加。

**决策 3：只读，不做增删改**

配角的在场状态由 `LifeService` 巡检与事件生成自动维护（24h 无提及降级），
用户手动改它没有明确语义。本 change 只读。

## 对账方向确认

- [x] 是否与现有 spec 冲突？**不冲突**——`ai-life-system` 声明了 ScenePresence 与每日摘要的
  数据能力，但从未声明 Web 出口。这是**补契约缺口**（同 `add-platforms-endpoint` 的性质），
  不是"doc 声明 impl 没接"
- [x] 涉及 Web API？**涉及**——必须同步 `docs/Web-API-Design.md`（§0.1 检查清单要求）

## 测试计划

- server：两个端点 200 + 返回结构；`/api/life/summaries` 与 `/api/life/templates` 路由不冲突
- server：服务模式下两个端点仍受鉴权保护（沿用全局钩子）
- console：适配层单测（空列表 / 缺字段 / 未知 status）
- 端到端：无头 Edge 截图 + `--dump-dom` 确认两栏渲染出真实内容、页面上不再出现「尚未接入」

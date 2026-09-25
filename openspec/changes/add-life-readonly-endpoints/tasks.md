# Tasks: add-life-readonly-endpoints

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [x] `GET /api/life/summaries` → `{ summaries: [{date, summary}] }`（窗口固定 7 天，与 `/api/life` 一致）
- [x] `GET /api/life/companions` → `{ companions: [{name, status, basis?, updatedAt}] }`
- [x] `docs/Web-API-Design.md`：§2.6 补两个路由 + §0 状态表加三行（含 templates 补登记）
- [x] console `lib/api/types.ts`：`LifeSummary` / `CompanionPresence` + 响应类型
- [x] console `lib/api/modules.ts`：`lifeApi.summaries()` / `lifeApi.companions()`
- [x] console `lib/adapt.ts`：`adaptSummaries` / `adaptCompanions` / `formatSummaryDate`
- [x] console 页面：`/life` 两个区块 + `/dashboard` 一个区块，`NotWired` → 真实数据
- [x] `NotWired` import 清理（`life-content.tsx` / `dashboard/page.tsx`）

### 测试

- [x] `packages/server/tests/webui-life-readonly.test.ts`（9 用例）：
      结构透传、空结果、**窗口固定 7 天**、与 `/api/life/templates` `/api/life` **路由不冲突**、
      服务模式下仍受鉴权保护（401 / 带 token 200）
- [x] `packages/console/tests/adapt.test.ts` 补 6 组用例：
      摘要日期标签、**date-only 本地解析不因 UTC 挪一天**、非法格式原样返回 + 告警、
      配角三状态标签、未知状态不静默丢、缺 basis、空/null 安全

### ★ 实现中的一个坑

`formatSummaryDate` 不能用 `new Date('2026-08-27')` 解析——那是 **UTC 午夜**，
东八区得 08:00 同天尚可，但**负时区会退回前一天**，日期标签就错一天。
改为按本地日历构造 `new Date(y, m-1, d)`，并加测试锁定。

## 实测验收（2026-09-25，无头 Edge）

服务端两个端点返回真实数据（摘要 8-27 起多条、迷迷 `present` + basis 原文）。
console 侧用 `--dump-dom` 拿 JS 执行后的 DOM 逐页断言：

| 页面 | 未接入 | 演示数据 | 报错 |
|---|---|---|---|
| `/life` | **0**（原 2） | 0 | 0 |
| `/dashboard` | **0**（原 1） | 0 | 0 |
| `/personality` | 1（护栏，合理） | 0 | 0 |
| `/chat` | 2 | 2（待做） | 0 |

`/life` 实测渲染出：摘要 13 条日期标签、配角 3 条状态（在场/离场/在场）、
生活素材库两组标签；截图确认三区块均有内容。

## Apply 任务

- [x] `openspec/specs/alysia-console/spec.md` §5：两个区块移出「未接入」表
- [x] `docs/Web-API-Design.md`：补登记 + 原「已知缺口」标注为已补
- [x] 更新 `docs/HANDOFF.md`
- [x] 回归：661 passed（+18）

## 遗留

- `/chat` 仍是演示数据（下一件：接 `/api/chat/stream`）
- 护栏实时状态无接口（PersonaAdapter 内部逻辑，展示的是设计约束本身）

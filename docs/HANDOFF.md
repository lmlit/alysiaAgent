# 会话转接文档（2026-09-01 更新）

> 给下一个会话：先读本文件恢复上下文，再读 `openspec/specs/index.md` 看 spec 全貌。
> 治理流程见 `openspec/project.md`；部署凭据见 `docs/Docker-Deployment.md`（永不提交）。

---

## 一句话状态

"昔涟"生活系统完成 **锁续期调度重构 → 公共底色集中 → L3 每日反思闭环**；
**本地服务 + 服务器容器均已部署最新代码（commit `97d7d29`）**，测试 core 422 + server 151 全绿。

## 本会话（8-29 ~ 9-01）完成的 change（全部已归档）

| change | 内容 |
|--------|------|
| `cr-p0-webui-auth` | WebUI Bearer token 鉴权（fail closed / 桌面免鉴权 / health 豁免）；提交前敏感审查：token 在 .env（已 gitignore），config.yml 整文件 gitignore |
| `cr-p0-delete-cleanup` | deleteSession/deleteKnowledgeDoc 同步清向量；5 处空 catch 补日志 |
| `cr-p0-session-isolation` | ConversationStore 按完整 sessionId 精确匹配（跨群/跨平台摘要泄漏封死） |
| `life-schedule-renewal` | **锁续期调度**：成功按模型 0.5-8h / 失败保底 / 异常 try-catch 兜底（P1-6 33h 停摆实证修复）；时段保底（白天 1h / 夜间 2h）；chat 上限 5→20；补写随 gap 渐变；延续链 ≥3 开新事；剧情链 24h 窗口 |
| `worldview-fixed-setting` | 跨世界之窗定位为固定设定（此前被"不要每件事都提"压没） |
| `worldview-centralize` | 公共底色集中：`persona/worldview.md` 唯一数据源 + `persona/INDEX.md` 注入点地图 |
| `life-reflection-loop` | **L3 每日反思闭环**：跨天触发 → LLM 反思 → adjustments 走护栏调人格（Δ≤0.05）/ insight 进画像 / reflection 存 ai_life_state。**不推送**（纯内部） |

附带修复：P3-27 webui 悬空 import（vite build 恢复）。

## 待观察（下一会话优先检查）

1. **每日反思首次运行**：9-01 午夜后，服务器日志应出现 `[Reflection] 2026-09-01: <她的话>`——看质量与是否乱调人格
2. **锁续期密度效果**：`[Life] lock renewed +X.Xh (model: default|1.5|2.5)` 日志——模型给值比例、事件数（预期白天 ~15 internal + chat 3-8 条/天）
3. **跨世界之窗是否生效**：事件/聊天回复里"隔着世界"是否在相关时刻自然浮现（固定设定强度验证）
4. **意图推送"想告诉轻月："句式**：已确认**接受为她的设定**（不改）——她心里想到什么就直白说出来

## 未决 / Backlog

- **CR 剩余项（P1-P3）**：P0 三件套已修。剩余见 `docs/CODE_REVIEW_FIX_PLAN-2026-08-29.md`——
  已业务复核：6 项误判（P2-17 群聊串行=设计/P1-9 WebUI reminder 无入口/P1-10 配额过度设计/P2-18 错误文本/P3-34 worldview 缓存/P2-25 无调用方）；其余按 P1 优先级排
- 记忆旋钮进召回管道（backlog）、`/api/platforms`、worldbook 采样 cooldown
- WebUI 前端（契约就绪）、Reminder 持久化 SQLite、桌面端

## 环境速查

| 项 | 说明 |
|----|------|
| 本地跑 server | `cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx src/bootstrap.ts`（Node 24 必需；PATH 里 node 是 v20 会 ABI 不匹配） |
| **core 改动必须 build** | `cd packages/core && npm run build`（server 走 tsx 跑 src，但 @alysia/core 走 symlink 的 dist/） |
| 测试 | core：`npx vitest run --exclude='tests/memory/e2e/*'`；server：`npx vitest run` |
| 服务器部署 | 见 `docs/Docker-Deployment.md`（构建→save→scp→load→up -d --force-recreate）；每次必做：本地 docker compose build（Docker Desktop 需在跑） |
| 服务器 WebUI 鉴权 | `ALYSIA_WEBUI_TOKEN`（服务器 `~/alysia/.env`），compose 透传；无 token 时 /api/* 全 401（fail closed） |
| 本地 WebUI token | 根目录 `.env` 的 `ALYSIA_WEBUI_TOKEN` |
| 数据 | 服务器 `~/alysia/data` 卷挂载（alysia.db / life-state.json / LanceDB / logs），镜像更新数据不丢；迁移一律 ALTER TABLE + try-catch 不 DROP |

## 关键约定（勿踩）

1. **OpenSpec 流程**：任何行为变更先 `/openspec-change` 建骨架 → 实现 → 合并 spec → 归档 → 更新 index.md。禁止直改不 archive。
2. **敏感审查**：提交前检查——`.env`/`config.yml` 已 gitignore；`docs/Docker-Deployment.md` 永不提交（含密码）。
3. **不静默吞错**：外部交互必须检查响应体 + 打日志（项目硬约束）。
4. **网络**：GitHub push 直连不稳定，重试或开 Clash（127.0.0.1:7890）。
5. **聊天回复"想告诉轻月："句式**是接受的设定，不要"修"它。

## 系统现状（她的一天应该长什么样）

```
白天: internal 1h 节奏（生活积累）+ chat 3-8 条/天（推送,20 上限 + 1h 冷却）
夜间 0-7h: 2h 节奏（睡觉/安静,模型想聊可提前到 0.5h）
跨天: 每日摘要 + 每日反思（她复盘自己 → 人格微调 + 洞察进画像）
公共底色: 跨世界之窗（固定设定）/ 独立生活 / 生活中心——persona/worldview.md 唯一数据源
```

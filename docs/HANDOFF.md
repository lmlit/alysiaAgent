# 会话转接文档（2026-09-25 更新）

> 给下一个会话：**先读本文件**恢复上下文，再读 `openspec/specs/index.md` 看 spec 全貌。
> 治理流程见 `openspec/project.md`；部署凭据见 `docs/Docker-Deployment.md`（永不提交）。
>
> 本文件只写「现在什么状态 + 下一步做什么 + 别踩什么」。
> 每个改动的**实现细节在对应的 `openspec/changes/<name>/`**（已提交，可查）。

---

## 一句话状态（2026-09-25）

**前端换代完成**：新前端 `packages/console`（Next.js）从收编一路做到能真用 ——
真数据 / 聊天流式 / Live2D / 本地部署形态。Vue 版 `packages/webui` **只剩一个空壳待删**。

**召回管道修好了**：修无关问题时用探针查出召回本身是坏的（三个缺陷），修好后
**生活事件召回 0 次 → 每话题 1-2 条**；`importance` 从"设计过从未接线"接上了；
**观测日志已上线**，现在就等运行数据。

当前：`master` @ `499690a`，已推送。**718 测试全过**，6 包构建。工作区干净。

---

## ⚡ 下一步（按优先级）

### 1. 部署到服务器 + 收运行数据（你已定，等执行）

**目的**：召回管道的**全部关键系数是启发式拍的**（不是从数据推的），该由运行数据定。

```bash
# ① 本地构建前端产物（必须！Dockerfile 只 COPY 不构建）
pnpm build:console

# ② 构建镜像（Docker Desktop 需在跑）
cd packages/server && docker compose build

# ③ 按 docs/Docker-Deployment.md 走（save → scp → load → up -d --force-recreate）

# ④ 跑 ≥1 周后捞数据
docker logs alysia-server --since 7d | grep '\[Recall\]'
```

`[Recall]` 一行一召，`候选 → 过阈值 → 选中 | 重要度加分×N | 耗时`。
详细计划与待验证假见 `openspec/changes/tune-recall-with-runtime-data/`。

**⚠️ 先积累再调，不边跑边调** —— 否则"变化是谁引起的"无法归因。

### 2. 删 `packages/webui`

三个删除约束（Electron / pet.html / Live2D）**全部解除**，可以收尾了。
需要一并处理服务端的 webui 回退路径（`server.ts` 的 `defaultDist`、`bootstrap.ts` 的
`IS_DESKTOP` 分支）—— **不是纯删**。未开工。

### 3. 挂着的 backlog

| change | 状态 |
|---|---|
| `console-a11y-motion` | 17 处动画缺 `prefers-reduced-motion` 守卫；hero 渐变在 `forced-colors` 下可能不可见。**用户指示先记档** |
| `add-platforms-endpoint` / `worldbook-sampling-cooldown` | 老 backlog，未做 |
| `play_live2d_action` 工具 + 输出驱动状态切换 | `window.live2d` 接口已就绪，未做 |
| 表情包渲染 `[表情包:名字]` | console 未接（现按纯文本显示），webui 有 |
| `soul.md` 的「Live2D 桌面空间」 | Electron 已砍，该表述与实际不符。**用户决定另开 change 改** |

---

## 本会话（9-24 ~ 9-25）做了什么 — 13 个 change

| change | 一句话 |
|---|---|
| `adopt-nextjs-console` | 收编新前端 + 接只读真数据；新建 spec `alysia-console` |
| `console-local-serve` | 静态导出 + Fastify 同源托管；**修 P0：鉴权钩子拦全部请求** |
| `server-bind-host` | 绑定地址与鉴权解耦（回环 ⇒ 免鉴权） |
| `add-life-readonly-endpoints` | 两个只读补口：`/api/life/summaries`、`/api/life/companions` |
| `wire-console-chat` | `/chat` 真链路（SSE + 会话列表 + 思考条 + **真能掐断的停止按钮**） |
| `drop-electron-desktop` | 砍 Electron + 删 `mock-data.ts`（臆造字段的源头） |
| `migrate-live2d-to-console` | Live2D 迁入，进各页 hero；补模型署名 |
| `live2d-persist-across-pages` | 实例跨路由不重建；**贴图 8192² → 2048²**（首屏 1.8s → 0.68s） |
| `optimize-recall-pipeline` | 召回三缺陷：距离度量 / 跨来源排序 / 无过滤 |
| `wire-importance-signal` | importance 接线（情绪强度 + 摘要时 LLM 打分） |
| `tune-recall-with-runtime-data` | 观测日志 + 回填脚本（**待运行数据**） |
| `console-a11y-motion` | 登记未实现 |
| `deploy-console-remote` | 产物进镜像 + SOP（**未实测**：本机 Docker 没跑） |

**挖出的既有问题**（都不报错、都有"看起来正常"的表象）：
根 `pnpm test` 空跑 / 鉴权钩子拦全部 / `expression-reset.ts` 是 GBK 编码 /
webui 停止按钮从未传 signal 给 fetch / `importance` 空转 / `webui-system` §8 与实现不符。

---

## ⚠️ 关键约定（勿踩）

1. **OpenSpec 流程**：任何行为变更（含前端）先 `/openspec-change` 建骨架 → 实现 →
   合并 spec → 归档 → 更新 index.md。**禁止直改不 archive**。
2. **敏感审查**：提交前检查 —— `.env`/`config.yml` 已 gitignore；
   `docs/Docker-Deployment.md` **永不提交**（含密码）。远端是**公开仓库**。
3. **不静默吞错**：外部交互必须检查响应体 + 打日志（项目硬约束）。
4. **改配置只改 `packages/server/config.yml`** —— 根目录那个 `config.yml` **是死文件**，
   改错**没有任何提示**（服务从 `packages/server` 启动，读 `cwd/config.yml`）。
5. **聊天回复「想告诉轻月：」句式**是接受的设定，不要"修"它。

---

## 环境速查

| 项 | 说明 |
|----|------|
| **本地跑 server** | `cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx src/bootstrap.ts`（**Node 24 必需**；PATH 里的 node 是 v20，ABI 不匹配） |
| **前端开发** | `pnpm dev:console`（3000，rewrites 代理 /api → 6185）。**必须用 corepack**：根 pin 了 pnpm@9.15.0，系统 pnpm 12 会改写 lockfile 格式、破坏 Docker 的 `--frozen-lockfile` |
| **前端本地部署** | `pnpm build:console` → 起 server → **`http://localhost:6185` 直开就是新前端**（同源单进程） |
| **⚠️ core 改动必须 build** | `cd packages/core && npm run build` —— server 走 tsx 跑 src，但 `@alysia/core` 走 symlink 的 **dist/**。不 build 你的改动**完全不生效且不报错** |
| 测试 | `pnpm --filter @alysia/{core,server,console} test`（core e2e 要 `--exclude='tests/memory/e2e/*'`）；根 `pnpm test` 跑全部 |
| **本地免鉴权** | `packages/server/config.yml` 设了 `host: "127.0.0.1"` → 只绑回环、局域网够不着、**不用输 token**。改回对外地址会自动恢复鉴权 |
| 鉴权边界 | 钩子**只守 `/api/*`**，静态资源与页面公开（见 `server-hardening` §6.1） |
| 前端分流 | 服务模式 → console；`ALYSIA_DESKTOP=1` → webui（UI-only 模式，已无 Electron 壳） |
| 服务器部署 | `docs/Docker-Deployment.md`（构建→save→scp→load→up -d --force-recreate） |
| 数据 | 服务器 `~/alysia/data` 卷挂载；迁移一律 **ALTER TABLE + try-catch 不 DROP** |

### 排查渲染问题的工具（本会话新发现，很好用）

机器上现成的 Edge 就能干，**零安装**：

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
"$EDGE" --headless=new --virtual-time-budget=9000 --dump-dom "URL"        # JS 执行后的 DOM
"$EDGE" --headless=new --window-size=1440,2600 --screenshot=out.png "URL" # 截图（我能 Read 出来看）
```

**⚠️ 大坑**：`--virtual-time-budget` 会**快进时间、破坏 rAF 驱动的渲染** ——
截图显示空白但页面其实是好的，**别据此误判**。要真实等待就用 CDP
（Node 24 自带 WebSocket，不需要 puppeteer）：导航 → `sleep` → `Page.captureScreenshot`。

---

## 上一会话（8-29 ~ 9-01）完成 — 全部已归档

生活系统：**锁续期调度重构 → 公共底色集中 → L3 每日反思闭环**。

| change | 内容 |
|--------|------|
| `cr-p0-webui-auth` / `cr-p0-delete-cleanup` / `cr-p0-session-isolation` | CR P0 三件套（鉴权 / 删除清向量 / 会话隔离） |
| `life-schedule-renewal` | 锁续期调度（修 33h 停摆）；时段保底；chat 上限 5→20 |
| `worldview-fixed-setting` / `worldview-centralize` | 跨世界之窗定位为固定设定；`persona/worldview.md` 唯一数据源 |
| `life-reflection-loop` | 每日反思：跨天 → LLM 反思 → adjustments 走护栏调人格 / insight 进画像 |

### ⚠️ 那批"待观察"项**已过期**，需在服务器上重新确认

9-01 留下的 4 条观察项（每日反思首跑 / 锁续期密度 / 跨世界之窗生效 / 意图推送句式）
**已过 25 天**，本地实例也不代表线上。等部署后再看。

**已知的一条**：本地实例的 `/api/life` 曾显示 `updatedAt` 停在 **9-03**、`events` 空 ——
但**起服务后立刻恢复**（跳回当前并生成新事件）。所以那不是数据坏了，是**没起服务**。

---

## 系统现状（她的一天应该长什么样）

```
白天: internal 1h 节奏（生活积累）+ chat 3-8 条/天（推送,20 上限 + 1h 冷却）
夜间 0-7h: 2h 节奏（睡觉/安静,模型想聊可提前到 0.5h）
跨天: 每日摘要 + 每日反思（她复盘自己 → 人格微调 + 洞察进画像）
公共底色: 跨世界之窗（固定设定）/ 独立生活 / 生活中心——persona/worldview.md 唯一数据源
```

## 架构速览（多形态）

```
@alysia/core        记忆 / 人格 / 生活 —— 唯一实现，所有形态共享
packages/server     把 core 包成进程：adapters + /api/* + 托管前端

接入面（同一个 eventBus.put 入口 → 同一条管线）：
  QQ / Telegram      adapters/
  Web 前端           console（现行）/ webui（待删）
  dsh 插件           dsh-adapter（人格接入）/ dsh-console（反代 6185）
```

**会话模型**：一个会话一直用（Web `sess-<ts>` / QQ 按用户），
靠**每 6h 的增量摘要归档**处理"永不结束的会话"。
上下文三层：短期 40 条/24h 窗口 → 长期增量摘要 → 向量召回。

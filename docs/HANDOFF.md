# 会话转接文档（2026-09-27 更新）

> 给下一个会话：**先读本文件**恢复上下文，再读 `openspec/specs/index.md` 看 spec 全貌。
> 治理流程见 `openspec/project.md`；部署凭据见 `docs/Docker-Deployment.md`（永不提交）。
>
> 本文件只写「现在什么状态 + 下一步做什么 + 别踩什么」。
> 每个改动的**实现细节在对应的 `openspec/changes/<name>/`**（已提交，可查）。

---

## 一句话状态（2026-09-27）

**存量已回填干净**（2026-09-27）：52 条占位符摘要全部重生成、40 条垃圾向量替换、
77 条缺失向量补齐。向量库 **2010 条**（chat 1470 / conversation 138 / life_event 402），
`summary LIKE 'Session %summary'` = **0**。

摘要管道已验证恢复（9-27 01:10：22 天来第一条真实摘要落库）。线上部署三次
（`00:45` 摘要解析 → `19:09` 窗口截断 → `23:11` 回填支持）。

**`tune-recall-with-runtime-data` 的阻塞已完全解除**：管道活着、数据干净，可以攒基线了。

**同时处理了一次凭据泄露**：服务器密码明文在公开仓库里躺了 28 天，已轮换作废。

**新前端 `packages/console` 已上线**（真数据 / 聊天流式 / Live2D / 同源托管）。

工作区干净，`master` @ `9af6de3`。**715 测试全过**（core 523 + server 192）。

---

## ⚡ 下一步（按优先级）

### 1. ✅ 摘要管道已验证恢复（2026-09-27 01:10）

**22 天来第一条真正生成的会话摘要已落库。** 证据链：

```
01:09:47  cron 触发
01:10:03  [SessionEnd] important_moments 回填 3/3 条   ← 失败路径走不到这里
01:10:06  [Memory] archived 1/1 sessions

库里: [ok] 23条 2026-09-26T17:10:03Z  ✅ 真实摘要
      "中秋前后两天，昔涟独自在乡下小院过节…"
      summary_status='failed' = 0
```

⚠️ **别只看日志判定**——这次是运气好（日志和数据一致）。上次 `archived 1/1` 骗了 18 小时。
**判定一律查库**。

### 2. ✅ 存量回填已完成（2026-09-27）

52 条占位符摘要重生成 + 40 条垃圾向量替换 + 77 条缺失向量补齐，全部经生产库验证。
细节见 `openspec/archive/2026-09-27-backfill-failed-session-summaries/`。

⚠️ 过程中踩了一个**同类型**的坑：回填脚本给 `ConversationStore` 传了 `null` vectorStore，
于是「52 条摘要全更新成功、40 条垃圾向量一条没换」，而日志全绿。**第四次**
「成功日志掩盖了没做的事」（前三次：占位符伪装摘要、存活伪装健康、空转伪装归档）。

### 3. `tune-recall-with-runtime-data` —— **阻塞已解除，可以开始攒数据了**

原计划是"部署 → 攒一周 → 调系数"。**摘要修复已上线**，所以现在攒出来的基线是干净的
（带着那个 bug 攒的话，垃圾向量会污染召回相似度分布）。

⚠️ 但仍要**先积累再调**：`[Recall]` 日志要等新版跑起来才有（旧镜像没这行）。

### 4. 其它 backlog

| change | 状态 |
|---|---|
| `add-ops-health-report` | 日报/监控。**用户 9-25 决定先记档后做**；前置：日志系统先整理（96.6% 是 QQ 噪声） |
| `clean-spec-diff-residue` | `specs/memory-system/spec.md` 残留 5 行 `+ ` 标记——**已两次让校验工具给出错误结论** |
| `console-a11y-motion` | 17 处动画缺 `prefers-reduced-motion`；用户指示先记档 |
| `add-platforms-endpoint` / `worldbook-sampling-cooldown` | 老 backlog，未做 |
| `play_live2d_action` 工具 + 输出驱动状态切换 | `window.live2d` 接口已就绪，未做 |
| 表情包渲染 `[表情包:名字]` | console 未接（现按纯文本显示），webui 有 |
| `soul.md` 的「Live2D 桌面空间」 | Electron 已砍，表述与实际不符。**用户决定另开 change 改** |
| 删 `packages/webui` | 三个删除约束全解除，但**不是纯删**（`server.ts` 的 `defaultDist`、`bootstrap.ts` 的 `IS_DESKTOP` 分支） |

### 5. 一个没查完的线索

`proactive.personalize` 槽 `max_tokens: 256` —— 按推理模型的账**比 512 更可疑**，
但日志里 proactive 看着是正常的，**没证据**。要么查，要么放着。

---

## 本会话（9-25 ~ 9-26）做了什么

| change | 一句话 |
|---|---|
| `fix-credential-leak-in-sync-script` | 服务器密码硬编码在公开仓库 28 天 → 已轮换 + 凭据外置到**仓库树外** |
| `fix-session-summary-silent-failure` | 会话摘要 22 天 100% 失败 → 失败不再伪装成成功 + 推理模型预算 |
| `fix-session-event-window-truncation` | 部署后验证发现：`getBySession` 取最旧 1000 条 → 归档空转 → 改取最近 N 条 + 空转可区分 |

**外加三个 backlog 立项**：`backfill-failed-session-summaries` / `add-ops-health-report` /
`clean-spec-diff-residue`。

### 🔴 事故一：凭据泄露（已闭环）

提交 `05a2651`（8-28）把服务器 sudo 密码明文写进 `sync-from-server.sh` 第 11 行，
随**公开仓库**暴露 28 天。核验该密码**同时是 `hexi` 的登录密码**（非独立 sudo 密码），
且 `passwordauthentication yes` → 危害链是「读仓库 → SSH 登录 → sudo root → 读 .env 与全库」。

**已处理**：密码轮换（旧密码验证失效）、核验无入侵迹象（`last` 仅 admin/root 止于 8-12；
`lastb` 全是公网爆破噪声）、仓库侧凭据外置。

**遗留**：SSH `passwordauthentication` 建议改 `no`（纵深防御，但有锁死风险，**需用户确认**）；
pre-commit 凭据扫描另立项。

### 🔴 事故二：会话摘要静默失败（22 天）

**证据链**：库里 134 会话，**最后一次真摘要是 9-03**；日志 `[SessionEnd] summary LLM failed`
4/4；镜像 9-01 构建、容器 ~9-04 重启 —— 严丝合缝。

**根因（真实 API 实测确认，非推测）**：`CHAT_MODEL` 是**推理模型**，
**reasoning 与可见内容共用同一个 `max_tokens`**，每次先花 ~250 tokens
（实测 `reasoning_tokens=242`）。512 的预算下对话稍长即"预算耗尽、content 为空"（HTTP 200、0 字）。

**这同一个 512 是两处故障的共同根因**（原以为是两个独立问题）：
- `session.summary` 槽 → 会话摘要 22 天 100% 失败
- `life.generateSummary` 槽（每日反思引用）→ 7 天 11 次 empty response

**触发点**：`b9c845d`（8-28 加 `character_perspective` 字段）→ reasoning 越界 → 成功率 55% → 0%。

**修复**：抽共用 `utils/llm-json.ts`；两个槽位 512 → 2048 + `response_format`；失败重试 1 次；
**失败不写占位符**（`summary=''` + `summary_status='failed'` + **不 embed**）；cron 自动补处理。

### 🔴 事故三：事件窗口取错端（**部署后才暴露**）

上一轮修完**部署上线**，容器跑 18 小时、cron 三次，**库里 0 条新摘要**，而日志一路报
`archived 1/1`（看着完全正常）。

**根因**：`EventStore.getBySession` 是 `ORDER BY created_at ASC LIMIT 1000` —— 取**最旧**的
1000 条，而调用方要的是"最近的会话内容"。主会话积累到 1436 条事件后，anchor 之后的事件
**一条都取不到** → `process()` 早退 → 空转。

**★ 这条推翻了事故二的归因**：此前把"最后真摘要是 9-03"归因于 8-28 的字段改动 + 9-01 部署；
实际该会话第 1000 条事件正是 **2026-09-03T01:26**，最后一条真摘要是 03:45。
**9-03 是"撞上 1000 上限"的日子。**

**修复**：`getBySession(sessionId, {limit?, since?})` 改为「最近的 N 条、可 `since` 过滤、
升序返回」，窗口过滤**下推到 SQL**；`process()` 返回 `SessionEndResult{summarized, reason}`，
`archiveStaleSessions` 按真实结果计数并区分「跳过/失败」。

**教训（最重要的那条）**：`archived++` 无条件自增，让"什么都没做"和"归档成功"在日志里
长得一模一样。**降级/空转必须可区分**——这是本项目第三次栽在同一类问题上
（占位符伪装成摘要、存活检查伪装成健康、空转伪装成归档）。

---

## ⚠️ 关键约定（勿踩）

1. **OpenSpec 流程**：任何行为变更（含前端）先 `/openspec-change` 建骨架 → 实现 →
   合并 spec → 归档 → 更新 index.md。**禁止直改不 archive**。
2. **敏感审查**：提交前检查。**凭据一律放仓库树之外**（`$HOME/.alysia-deploy-credentials`）——
   树内文件 + gitignore 只是"约定"不是"保证"，`docs/Docker-Deployment.md` 自身就是反例。
3. **不静默吞错**：外部交互必须检查响应体 + 打日志。
   ⚠️ 但也要注意**降级不等于可见**——`catch → 存默认值` 会把故障伪装成成功，
   摘要那 22 天就是这么丢的。**要进长期记忆的数据，失败宁可不存也不要存垃圾。**
4. **改配置只改 `packages/server/config.yml`** —— 根目录那个 `config.yml` **是死文件**，
   改错**没有任何提示**。
5. **聊天回复「想告诉轻月：」句式**是接受的设定，不要"修"它。
6. **★ 推理模型的 max_tokens**：`CHAT_MODEL` 是推理模型，**reasoning 与可见内容共用预算**。
   结构化输出槽位必须 ≥1024，否则会得到 HTTP 200 + 空内容。
   **单测抓不到**（LLM 是 mock 的）→ 改 prompt / 换模型 / 调采样后**跑
   `packages/server/scripts/verify-session-summary-fix.ts`**（真实 API 探针）。
7. **★ 计数类日志必须反映真实结果**：`archived++` / `summaryGenerated: true` /
   `{"status":"ok"}` 这类**无条件成功值**是"静默故障"的温床。本项目已栽三次：
   占位符伪装成摘要、存活检查伪装成健康、**空转伪装成归档**。
   凡是"成功/完成"的日志，都要问一句：**失败路径会不会走到这里？**
8. **★ 部署后的验证必须查数据，不能只看日志**：事故三就是被 `archived 1/1` 骗了 18 小时。
   判定标准写进「下一步」了。
9. **★ spec 里有残留的 `+ ` diff 标记**（`memory-system` 末尾 5 行）。任何基于
   `grep '^+ '` 的合并/校验都会被它带偏——**合并后用"删掉插入段应逐字节还原"来验证**，
   别只数行数。

---

## 环境速查

| 项 | 说明 |
|----|------|
| **本地跑 server** | `cd packages/server && PATH="/e/nodejs24:$PATH" npx tsx src/bootstrap.ts` |
| **★ 本地跑测试也要 Node 24** | `PATH="/e/nodejs24:$PATH" npx vitest run`。PATH 里的 node 是 v20，**better-sqlite3 ABI 不匹配 → 满屏测试失败**（看起来像代码坏了，其实不是） |
| **前端开发** | `pnpm dev:console`（3000，rewrites 代理 /api → 6185）。**必须用 corepack**：根 pin 了 pnpm@9.15.0 |
| **前端本地部署** | `pnpm build:console` → 起 server → `http://localhost:6185` 直开 |
| **★ core 改动必须 build** | `cd packages/core && npm run build` —— server 走 tsx 跑 src，但 `@alysia/core` 走 symlink 的 **dist/**。不 build 你的改动**完全不生效且不报错** |
| 测试 | `pnpm --filter @alysia/{core,server,console} test`（core e2e 要 `--exclude='tests/memory/e2e/*'`） |
| **本地免鉴权** | `packages/server/config.yml` 设 `host` 会**破坏部署**（见下）。本机想只绑回环请在**根目录 `.env`** 写 `ALYSIA_HOST=127.0.0.1` |
| 鉴权边界 | 钩子**只守 `/api/*`**，静态资源与页面公开 |
| 前端分流 | 服务模式 → console；`ALYSIA_DESKTOP=1` → webui（UI-only，已无 Electron 壳） |
| 服务器 | `hexi@121.41.111.120`（阿里云）。宿主机端口 **6186** → 容器 6185 |
| 服务器凭据 | `$HOME/.alysia-deploy-credentials`（仓库树外）。轮换密码后**同步更新它** |
| 服务器库备份 | `~/alysia/data/alysia.db.bak-*`（`before-summaryfix` / `before-windowfix` / `before-backfill`） |
| 回滚（两个锚点） | `sudo docker tag server-alysia:<tag> server-alysia:latest && sudo docker compose -f ~/alysia/compose.yml up -d`<br>`rollback-20260901` = 9-01 老版；`rollback-20260926a` = 只有摘要解析修复；`rollback-20260927` = 无 until/回填 |
| **部署后必须查数据** | 别只看 `archived N/N` 或容器 healthy（见约定 7/8） |
| 数据 | 服务器 `~/alysia/data` 卷挂载；迁移一律 **ALTER TABLE + try-catch 不 DROP** |

### ★ Docker 代理坑（2026-09-26 踩到并修复）

**症状**：`docker compose build` 报 `ECONNRESET` / 拉镜像 `connection refused`，
看起来像网络问题或墙。

**真因**：Docker Desktop 的代理配置（`%APPDATA%\Docker\settings-store.json` 的
`OverrideProxy*` / `ContainersOverrideProxy*`）指向 **`127.0.0.1:7890`** ——
那是**旧版 Clash for Windows** 的端口。当前用的 **Clash Verge 是 `mixed-port: 7897`**。

**已修**：6 处 `7890` → `7897`（改前备份了 settings-store.json）。
⚠️ 改这个文件**必须先 `docker desktop stop`**，否则 Docker 退出时会覆盖回去。

**排查口径**：`netstat -ano | grep LISTENING | grep 789` 看代理实际端口，
别假设还是 7890（`~/.claude/skills/clash-proxy.md` 里写的 7890 已过时）。

### 排查渲染问题的工具（零安装）

```bash
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
"$EDGE" --headless=new --virtual-time-budget=9000 --dump-dom "URL"        # JS 执行后的 DOM
"$EDGE" --headless=new --window-size=1440,2600 --screenshot=out.png "URL" # 截图
```

**⚠️ 大坑**：`--virtual-time-budget` 会**快进时间、破坏 rAF 驱动的渲染** ——
截图显示空白但页面其实是好的，**别据此误判**。要真实等待就用 CDP。

---

## 上一会话（8-29 ~ 9-01）完成 — 全部已归档

生活系统：**锁续期调度重构 → 公共底色集中 → L3 每日反思闭环**。

| change | 内容 |
|--------|------|
| `cr-p0-webui-auth` / `cr-p0-delete-cleanup` / `cr-p0-session-isolation` | CR P0 三件套 |
| `life-schedule-renewal` | 锁续期调度（修 33h 停摆）；时段保底；chat 上限 5→20 |
| `worldview-fixed-setting` / `worldview-centralize` | 跨世界之窗定位为固定设定 |
| `life-reflection-loop` | 每日反思：跨天 → LLM 反思 → adjustments 走护栏调人格 / insight 进画像 |

### ⚠️ 那批"待观察"项已过期 26 天，需重新确认

每日反思首跑 / 锁续期密度 / 跨世界之窗生效 / 意图推送句式 —— 等本次部署后再看。

**已知的一条**：本地实例的 `/api/life` 曾显示 `updatedAt` 停在 9-03、`events` 空 ——
但**起服务后立刻恢复**。所以那不是数据坏了，是**没起服务**。

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

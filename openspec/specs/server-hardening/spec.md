---
status: active
source: docs/superpowers/specs/2026-08-02-server-hardening.md
migrated: 2026-08-07
---
# 服务端加固 — 设计文档

> 日期: 2026-08-02
> 状态: 进行中
> 前置: 日志系统（统一 logger）已完成

---

## 1. 背景

代码自检 + 日志系统补完后遗留的体验/健壮性问题，按优先级选取 5 项：

| # | 问题 | 影响 |
|---|------|------|
| 1 | 主动消息去重状态在内存，重启丢失 | 重启当天问候/节日祝福**重复发送** |
| 2 | 日志只进终端，无文件持久化 | 服务重启日志全丢，无法回溯排查 |
| 3 | server 包零测试 | adapter 解析、主动消息判断无回归保护 |
| 4 | 画像提取 fallback 逻辑错误 | **已修复**（ProfileExtractor catch 返回 baseResult，见代码注释）——本次仅确认记录 |
| 5 | 死代码：matchWorldbook / vectordb 依赖 | 无调用方、无 import 的残留 |

---

## 2. 方案

### 2.1 主动消息去重持久化（proactive.ts）

- 去重状态（sentGreetings / sentFestivals / lastCareByUser）序列化到 `{dataDir}/proactive-state.json`
- 策略：**tick 时加载 → 内存维护 → 变更即写回**（防抖 1s，避免高频写盘）
- 写入失败不阻塞主流程（只 warn）
- 文件结构：`{ "sentGreetings": ["2026-08-02-9"], "sentFestivals": ["2026-08-02"], "lastCare": {"openid": "2026-08-02"} }`

### 2.2 日志文件持久化（logger.ts）

- 控制台 + 文件双写：`{dataDir}/logs/alysia-YYYY-MM-DD.log`
- 滚动：每次启动清理超过 **7 天**的旧日志文件
- 级别：全部级别写文件（debug 仍受 ALYSIA_DEBUG 控制）
- 实现：logger 模块内部维护文件句柄，`logger.configure({ logDir })` 由 bootstrap 启动时调用（无配置则保持纯控制台，兼容测试/CLI）
- 注意：logger 在 core 包，logDir 由 server 传入——**core 不持有 server 配置**，configure 幂等

### 2.3 Server 测试（vitest）

新增 `packages/server/tests/`：
- `proactive.test.ts`：时段问候触发判断、节日/节气识别（用真实日期表 + mock 日期）、去重状态加载/保存
- `qq-official.test.ts`：`[表情包:名字]` 标记解析（含多标记、无标记、混合文本）
- `config.test.ts`：config.yml 加载、环境变量插值

### 2.4 画像 fallback — 已修复确认

`ProfileExtractor.detectCorrectionSignal` 的 catch 已返回 `baseResult`（不把整条消息当修正目标），自检报告 #11 过期。**无需改动**。

### 2.5 死代码清理

| 目标 | 处理 |
|------|------|
| `MemoryManager.matchWorldbook()` | 删除（@deprecated 且零调用） |
| `packages/core/package.json` 的 `vectordb` 依赖 | 移除（源码零 import） |
| vectorStore/embed 分支 | **保留**——`vectorStore` 恒 null 是"预留 LanceDB 接入"的显式标记（Web-API-Design 约束：接口留给桌面端/未来），不删接口与守卫 |

---

## 3. 影响面

- proactive.ts：构造签名不变，新增文件读写
- logger.ts：新增 configure + 文件写；现有调用不变
- 新增 server 测试文件 3 个；core 测试不受影响

## 4. 验证

- `npx vitest run`（core 199 + server 新增）
- 重启服务 → 确认 `logs/alysia-2026-08-02.log` 生成
- 连续两次启动 → 去重状态不重置（手动查 proactive-state.json）

## 5. 运行时可靠性（2026-08-08，change: server-reliability-fixes / owner-id-env-injection）

- **.env 加载**（bootstrap）：手写解析器 → dotenv（支持引号/转义；默认不覆盖已存在
  变量——容器 compose environment 优先）。路径 `{cwd}/../../.env`（仓库根），文件
  不存在静默跳过（Docker 场景走环境变量）
- **cron 防重叠**（bootstrap）：6h 定时记忆压缩加 in-flight 锁——cron() 含 LLM 深度
  画像重写，单次执行超 6h 时跳过本次触发，防并发重入
- **ownerId 凭据化**（8-08 线上故障 11255 修复）：openid 与 QQ AppID **绑定**——换 bot
  后旧 openid 失效，主动消息报 `500 code 11255 invalid request`。config.yml
  `ownerId: "${QQ_OWNER_ID}"` 由 .env 注入（与 appid/secret 同机制，部署不漂移）；
  **compose environment 必须透传 QQ_OWNER_ID**——缺失时插值空串 →
  ProactiveService/LifeService 静默不启动（本次排查实证）。换 bot 三步：改 .env 的
  QQ_APP_ID/QQ_APP_SECRET/QQ_OWNER_ID → 重建容器 → 验证问候
- **healthcheck IPv4**（8-08）：compose healthcheck 必须用 `127.0.0.1` 而非
  `localhost`——alpine busybox 将 localhost 解析为 IPv6 `::1`，服务只监听 IPv4
  `0.0.0.0` → 恒 refused → 容器恒 unhealthy（实测 FailingStreak 1238）

## 6. WebUI 鉴权（2026-08-29，change: cr-p0-webui-auth）

WebUI 管理面板零鉴权绑 0.0.0.0 是 P0 隐私风险（公网部署下任意设备可读画像/会话、
删数据、经 /api/chat/stream 烧 LLM 额度）：

- **鉴权触发条件（★ 9-25 server-bind-host 修订）**：**由绑定地址决定**，不再由模式决定——
  绑定**回环** ⇒ 仅本机可达 ⇒ 免鉴权；绑定对外地址 ⇒ 所有 `/api/*` 校验
  `Authorization: Bearer <token>`，缺失/错误 → 401。chat 路由（registerChatRoutes）同受钩子保护。
  *修订理由*：原「服务模式强制鉴权」使本地用户被迫把服务暴露到局域网才用得上 WebUI。
  改成跟随绑定地址后，「对外可达 ⇒ 必须鉴权」成为不可绕过的推论（不提供独立 requireAuth
  开关——两个开关能配出 `0.0.0.0` + 免鉴权 = 局域网裸奔）。绑定地址见
  `server.host`（缺省：桌面 127.0.0.1 / 服务 0.0.0.0，与修订前一致）
- **token 来源**：config.yml `server.webuiToken: "${ALYSIA_WEBUI_TOKEN}"`
  （env 注入，与 ownerId 同机制）；compose environment 必须透传 ALYSIA_WEBUI_TOKEN
- **fail closed**：**需鉴权时**未配置 token → 全部拒绝（401）+ 启动 logger.warn 提示配置
  ——杜绝零鉴权裸奔
- **桌面模式**（ALYSIA_DESKTOP=1）：绑 127.0.0.1 + 免鉴权。
  ★ 9-25 后这只是回环规则的一个实例（桌面模式的默认绑定地址是回环）；
  想要"本地 + 免鉴权"**不必**开桌面模式（那会连带关掉 IM 适配器/主动推送/切换前端），
  在 config.yml 写 `server.host: "127.0.0.1"` 即可
- **/api/health 豁免**：容器 healthcheck 无 token 可配（compose healthcheck 不受影响）
- **前端**：localStorage `webui_token` 附加 Authorization 头；401 → 登录遮罩
  （输入 token 后重载）；静态资源不鉴权（SPA 壳可加载，数据保护点在 API）

### 6.1 修复：钩子范围（2026-09-24，change: console-local-serve）

★ **原实现违反了本节第 6 条**：`onRequest` 钩子拦下**所有**请求，不只是 `/api/*`。
后果：浏览器导航到 `/` 无法携带 `Authorization` 头 → 401 → **前端页面根本加载不出来**。

未暴露的原因：静态文件从不由 Fastify 出（本地走 vite dev；Docker 镜像未打包 dist），
且已有测试只覆盖 `/api/*` 路径。

修复要点：
- 钩子只守 `/api/*`（`path.startsWith('/api/')`），其余直接放行
- 路径判断**先剥 query**——原实现 `req.url === '/api/health'` 精确匹配，
  带 query 的 `/api/health?probe=1` 会被误拦（healthcheck 变体会踩到）
- 回归测试见 `packages/server/tests/webui-auth.test.ts`（补非 API 路径用例）

## 7. 会话端点校验（2026-10-20，change: `guard-session-extract-endpoint`；KI-18）

### 7.1 问题：同文件的邻居都有边界，只有结算端点没有

| 端点 | 改前的边界 |
|---|---|
| `POST /api/ingest` | 只收 `dsh:` 前缀（`ingest.ts`） |
| `POST /api/sessions/:id/archive` | 只收 `webui:` |
| `DELETE /api/sessions/:id` | 只收 `webui:` |
| **`POST /api/sessions/:id/extract`** | **无** |

后果两层：① **成本**——任意 id 都能触发结算（摘要 + 画像提取 + 人格确认），全是真 LLM 调用，
而摘要槽正是本项目已爆三次预算事故的那个；② **正确性**——结算不该发生在不该结算的会话上。
2026-10-02 的子 agent 污染事件里，它正是「插件回传 + 结算」链路的落点
（插件侧过滤已堵住那一条，**端点本身当时仍敞着**）。

还有一层是**失败不可见**：会话不存在时 `extractProfile` 返回
`{factsExtracted:0, summaryGenerated:false}` —— 一个**成功形状的空转**，
前端「提取画像」按钮分不清「这个会话很干净」和「这个会话根本不存在」。

### 7.2 契约

**契约 1：`id` 形状必须校验。** 空、或解码后含 `/` ⇒ **400**。

**契约 2：`dsh:unknown` 必须拒（400）。**
它是适配器拿不到 `session.id` 时的**退化桶**（`ingest.ts` 的 `UNKNOWN_SESSION_ID`），
不是真实会话；结算它会把多个真实会话的内容混进同一份摘要与画像。
判据**复用同一个常量**，不另造字符串。

**契约 3：零事件 ⇒ 404，且不得调用 `extractProfile`。**
判据是「**有没有事件**」，不是「会不会产出新事实」——
后者是结算的**结果**，拿来当入口判据会把「干净但真实」的会话误杀。

**契约 4：存在性由 core 暴露，路由不碰 DB。**
`MemoryManager.countSessionEvents(sessionId): number`（只读、纯数据，包装
`EventStore.countBySession`）—— 遵守「Web 端接口兼容」硬约束，
登记在 `docs/Web-API-Design.md` §2.2。

**契约 5：刻意不加「只允许 `dsh:` 前缀」。**
本端点同时服务 WebUI 会话的手动提取；按来源一刀切会砍掉合法用法
（这也正是当初没加校验的合理部分）。

测试：`packages/server/tests/extract-endpoint-guard.test.ts`（4 条，含正常路径不回归）。

## 8. 网关帧解析不得静默丢弃（2026-10-26，change: `harden-silent-failures`；KI-5）

### 8.1 问题：两处裸 `catch {}` 把"坏帧"变成"没有消息"

QQ 官方网关的帧载荷解析曾有两处裸 `catch {}`（握手尾随帧、正常帧）。
后果不是崩溃，而是**静默丢帧**：网关改字段、发出半截 JSON、或某类事件结构变化时，
整帧被丢掉，症状是「Bot 在线，但某些消息永不触发」，日志里**零行**可查
（KI-5 同族：错误被降级成"没有发生"）。

### 8.2 契约

**契约 1：坏帧不得抛出。**
一帧坏不等于连接坏；抛出会打断 socket，把"丢一帧"升级成"断整条连接"。

**契约 2：必须留痕，且带判据。**
`warn` 至少带 **阶段**（握手尾随 / 网关）、**字节数**、**累计次数**与**原因**。
「没有消息」与「消息被丢掉」必须可区分。

**契约 3：限频，但不得静默。**
前 3 次逐条；之后每 100 次一条。限频是为了不让坏流刷屏埋掉真信号，
不是允许不报（计数仍在累加，日志里能看出"已经 N 次"）。

**契约 4：机器闸。**
`scripts/check-bare-catch.cjs` 命中**真·空 catch**（块内既无代码也无注释）⇒ exit 1，
已接进 pre-commit。注释说明过的 best-effort 不拦——那是有意的降级，不是吞。

测试：`packages/server/tests/qq-official.test.ts`（新增 2 条：非法 JSON 不抛且 warn、
连续坏帧前 3 次逐条）。

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

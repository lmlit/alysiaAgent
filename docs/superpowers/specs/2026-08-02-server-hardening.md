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

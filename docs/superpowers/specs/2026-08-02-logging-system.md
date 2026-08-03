# 日志系统 — 设计文档

> 日期: 2026-08-02  
> 状态: 已实现（2026-08-04 更新：文件持久化 + 本地时间）  
> 前置: 无（独立于其他系统）

---

## 1. 背景与目标

### 1.1 痛点（审计结论）

| 痛点 | 表现 |
|------|------|
| 消息接收无正文日志 | 三个 adapter 全缺，排查"群里谁发了什么 / 是否 @ 了 bot"只能靠猜 |
| LLM 调用黑盒 | 只有错误日志，成功调用无耗时/tokens，成本与性能无法监控 |
| 工具执行零日志 | `tools/` 全目录无日志，web-search 搜了什么、reminder 设置成功没都不可见 |
| pipeline 链路黑盒 | EventBus 分发、memory-ingest、worldbook 无日志，只能看"收到"和"发出"两头 |
| 格式不统一 | 裸 console（145处）与 logger（29处）混用，裸 console 无时间戳/级别 |

### 1.2 目标

- **边界节点**（消息收/发）与**链路中间节点**（LLM/工具/记忆/pipeline）都有日志
- 全仓库统一走 `logger`（时间戳 + 级别），裸 console 仅保留在 CLI 交互界面、测试、脚本
- 日志可读：正文/结果摘要截断（100-200 字符），防止刷屏

---

## 2. 基础设施

### 2.1 Logger（core/src/utils/logger.ts）

```
logger.debug(msg)   # 需环境变量 ALYSIA_DEBUG 才输出（高频路径：EventBus.put、ingest）
logger.info(msg)    # 常规链路节点
logger.warn(msg)    # 可恢复异常（fallback、降级）
logger.error(msg)   # 失败（带耗时，输出到 stderr）
```

- **格式**：`[YYYY-MM-DD HH:mm:ss] [LEVEL] 消息`
- **时区**：使用系统本地时间（`getFullYear/getMonth/getDate/getHours/getMinutes/getSeconds`），非 UTC
- **文件持久化**：`logger.configure({ logDir })` 启用
  - 控制台 + 文件双写（`appendFileSync`）
  - 每日滚动：文件名 `alysia-YYYY-MM-DD.log`
  - 自动清理：启动时删除 7 天前的日志文件
  - 写文件失败不抛异常（不影响控制台输出）
- **未配置 logDir 时**：纯控制台输出（兼容测试/CLI 环境）

### 2.2 统一规则

- server 包导入 `import { logger } from '@alysia/core'`
- 各适配器保留 `[QQ Official]` / `[QQ]` / `[Telegram]` 前缀标签便于过滤
- 摘要截断约定：消息正文 100 字符、LLM 回复 80-120 字符、工具参数/结果 200 字符

---

## 3. 日志节点清单（已实现）

### 3.1 消息边界

| 节点 | 位置 | 内容 |
|------|------|------|
| 接收（QQ Official） | qq-official.ts handleGatewayMessage | 事件类型 + session 尾 16 位 + 作者 + 正文 100 字符 |
| 接收（QQ OneBot） | qq-onebot.ts handleMessage | 群/私 + from + session + 正文 100 字符 |
| 接收（Telegram） | telegram.ts onMessage | 群/私 + from + chat id + 正文 100 字符 |
| 发送（QQ Official） | qq-official.ts sendReply | 回复前 80 字符 + 图片数 + chatType |
| 发送（QQ OneBot） | qq-onebot.ts doSend | 回复摘要 80 字符 |
| 发送（Telegram） | telegram.ts doSend | 组件数 + 目标 + 文本摘要 |
| 主动推送 | proactive.ts sendProactive | openid 前 8 位 + OK/fail + 错误体 |

### 3.2 链路中间节点

| 节点 | 位置 | 内容 |
|------|------|------|
| EventBus 分发 | eventbus/EventBus.ts | umo + pipelineMode + put(queue)（put 走 debug 级） |
| 工具执行 | tools/registry.ts execute | 工具名 + 参数摘要 → 结果摘要 + 耗时；失败带耗时 |
| LLM 调用（成功） | provider/openai.ts textChat | 模型 + 回复/工具调用摘要 + tokens + 耗时 |
| LLM 调用（失败） | provider/openai.ts | 非 200 带错误体、超时、请求错误，全部带耗时 |
| LLM stream | provider/openai.ts textChatStream | 开始（到 header 耗时）+ API 错误 |
| Provider fallback | provider/manager.ts | 失败 warn + 切换成功 info |
| 回复完成 | pipeline/stages/llm-agent.ts | `← 用户消息摘要` / `→ 回复摘要 + 耗时` |
| 记忆写入 | memory/MemoryManager.ts ingest | 保存的 event id + 内容截断（debug 级，skip/full 标记） |
| 会话结束 | memory/MemoryManager.ts onSessionEnd | 摘要+画像开始/完成 + 耗时 |
| 画像提取 | memory/MemoryManager.ts extractProfile | 新 facts 数 + 耗时 |
| 定时压缩 | memory/MemoryManager.ts cron | 开始/完成 + 耗时 |
| 角色包加载 | core/src/index.ts loadRolePackages | 文件名 → role + worldbook 数 |
| 命令执行 | core/src/index.ts sessionCmds | `/new` `/reset` `/stop` 触发 + session 尾 20 位 |

### 3.3 启动编排（server/src/bootstrap.ts）

- .env 加载、各平台启动、ProactiveService 启动、WebUI 启动、Reminder push sent/failed
- 日志目录配置：`logger.configure({ logDir })` + 日志文件路径输出

---

## 4. 保留裸 console 的例外

- `server/src/chat.ts` — CLI 交互界面（用户界面输出，非系统日志）
- `server/src/cli-runner.ts` — CLI 运行器
- `tests/`、`scripts/`、`tmp-*.ts` — 一次性/测试工具
- `utils/logger.ts` 自身 — `console.log` / `console.error` 是日志输出的最终出口

### 4.1 已知的裸 console（待迁移）

- `packages/server/src/adapters/qq-official.ts:654` — `this.run().catch(console.error)` 在重连定时器中。影响小（仅重连异常时可见），但应迁移到 `logger.error` 以保持一致性。

---

## 5. 待办

- [x] 日志文件持久化（文件滚动、保留 N 天）— 已实现：每日滚动 `alysia-YYYY-MM-DD.log`，启动时清理 7 天前
- [ ] 日志级别通过环境变量/配置文件控制（当前仅 debug 级受 `ALYSIA_DEBUG` 控制）
- [ ] 敏感信息过滤（私聊消息正文可能含隐私，写文件时脱敏？——暂保持本地明文）
- [ ] qq-official.ts 重连路径的 `console.error` 迁移到 `logger.error`

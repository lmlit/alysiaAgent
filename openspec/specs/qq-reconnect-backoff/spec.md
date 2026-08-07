---
status: frozen
source: docs/superpowers/specs/2026-08-02-qq-reconnect-backoff.md
migrated: 2026-08-07
---
# QQ 断线自动重连（指数退避）

> 日期：2026-08-02 · 状态：✅ 已实现 · 类型：Bug 修复

## 背景

用户出门（手机热点断网）1.5 小时，服务挂起：断网瞬间 WS 断开 → 调度一次重连 → 重连时 token/gateway 获取失败（`run()` 直接 return）→ **不再有任何重试**。网络恢复后服务永久停摆，只能手动重启。

## 根因

`QQOfficialAgentAdapter.run()` 两条失败路径没有调度重连：

1. `refreshToken()` 失败（`!this.accessToken`）→ `return`
2. `getGatewayUrl()` 失败（`!wssUrl`）→ `return`

只有 WS socket `close` 事件才触发 `scheduleReconnect()`。断网时恰好执行到 token 获取失败，后续无重试。

## 修复

- `run()` 两条失败路径统一调用 `scheduleReconnect('')`——任何原因连不上都持续重试
- `scheduleReconnect` 指数退避：**5s → 15s → 45s → 135s → 上限 300s**（×3 递增，`Math.min(delay * 3, 300_000)`）
- READY 事件（`✅ Bot ONLINE`）时重置退避为 5s（下次断线从头开始）
- `reconnectTimer` 防重入：已有定时器时不重复调度

## 验证

- server 构建通过，服务重启正常上线（READY session 正常）
- 退避序列：5→15→45→135→300→300…（测试未单独编写——重连依赖真实网络，靠日志观测）

## 平台已知行为：30 分钟强制重连（2026-08-08 实测补充）

QQ 官方网关（api.sgroup.qq.com）**每 30 分钟发送一次 op:7（Server requested reconnect）**：
8-06/8-07 实测均为每天 47 次、间隔精确 30 分钟（00:15→00:45→01:29→01:59→02:29…）。

- **属平台机制，非异常**：与账号活跃度、心跳无关（心跳 41250ms 一直正常）
- 重连实现已验证稳定：5s 退避 → token → gateway → READY，全程 6-10s，主动消息发送无失败
- **影响**：重连窗口内主动消息可能撞上断线——已由"先发后标记 + 失败重试"兜底（问候失败重试见 proactive-messages spec §2.1.6）

## 待办

- 退避逻辑可提取为可测试的纯函数（返回 delay 序列），若后续想补单测再做

# Tasks: watch-for-stuck-work

> 每个任务完成后勾选；全部完成才 apply（合并 spec）→ archive。

## 实现任务

- [x] `packages/server/src/watchdog.ts`：纯函数 `evaluateWatchdogFacts()`（六条判据）+ `planWatchdogNotifications()`
      （冷却/恢复）+ `WatchdogService`（定时、去重状态、`runOnce()` 可单测）
- [x] `packages/core/src/memory/watchdog-notice.ts`：看门狗措辞提示词（**只准说事实里有的**、≤160 字、≤3 句）
      + `finalizeWatchdogNotice()`（去前缀/引号、硬截断）
- [x] `MemoryManager.composeWatchdogNotice()`：模型失败 ⇒ `null`（调用方回落模板）
- [x] `packages/server/src/modules/watchdog.ts`：`al:watchdog` 模块（gather 读数 + 她来说 + 回落模板 + 开机计数）
- [x] `bootstrap.ts` / `modules/index.ts`：注册模块
- [x] `config.ts`：`watchdog` 段 + `sanitizeWatchdog()`（**显式映射**，默认开）
- [x] `scripts/project-task-runner.mjs`：每轮 `GET /` 探站点（3s 超时、**读掉 body**）+ 带给服务端
- [x] `packages/server/src/host-pages.ts`：payload 支持可选 `site`
- [x] 测试：`packages/server/tests/watchdog.test.ts`（26 例）

## 实现中改掉的一个设计错误（重要）

最初判据⑥写成 `uptimeSec < 300 ⇒ 报"我刚重启过"` ⇒ **每次部署都会先发一条假警报**。
改成"一小时内开机 ≥3 次"（`watchdog-boots.json` 落盘计数），并给 `WatchdogService` 加
"第一轮不报 fresh-restart" 的第二道保险。

## 部署任务

- [x] core `MemoryManager.js` + `watchdog-notice.js`；server `watchdog.js` / `modules/watchdog.js` /
      `modules/index.js` / `bootstrap.js` / `config.js` / `host-pages.js`；runner
- [x] **踩坑**：`dist/watchdog.js` 与 `dist/modules/watchdog.js` **同名**，scp 到 `/tmp` 互相覆盖 ⇒
      容器 crash-loop（`ERR_MODULE_NOT_FOUND` / 缺 export），站点的 API 断了几分钟。
      修法：上传时**改名**（`wd-core.js` / `wd-module.js`），且先 `docker stop` 再 `docker cp`
      （容器 restarting 时 `docker cp` 会失败）。

## 真机验证

- [x] 启动日志：`[Watchdog] 已启动：每 60s 判一次（只读，不处理）`
- [x] 容器 healthy、QQ ONLINE、`[host-pages] 收到页面清单：13 页`
- [ ] 正常状态下**不发消息**（等一轮 60s 观察）
- [ ] 故意制造一次 `site-down`（停 preview 服务 10 秒）→ 确认她的通知**像人话**、且恢复时补一条
      （下一轮做；不在生产上乱停服务）

## 遗留（不阻塞归档）

- 判据阈值现在只能改 `config.yml` 的 `watchdog` 段；要不要给她一个"别吵了"的静音指令，
  由 B 档（受限动作）一起定

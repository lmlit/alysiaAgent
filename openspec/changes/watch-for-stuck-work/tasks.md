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

## 真机第二轮：看门狗自己先变成了噪声（必须记下来）

上线后一小时它发了 **5 条**，其中：

- 02:03:58 真问题（3 个 unknown 任务）—— ✅ 这条是对的，措辞也像她；
- 02:05:16 同一个问题**又发一遍**（重启后忘了）；
- 02:06:15 **假的"恢复了"**：「刚才那件事好了：有个活没跑完就断了；…×5」——那几个活根本没变；
- 02:07:36 又一遍；
- 02:12:22 「最近一小时重启了三次」——**那是我在部署**，不是崩溃循环。

三个真因，全部修掉：

| 问题 | 修法 |
|---|---|
| 冷却状态只在内存 ⇒ 每次重启重发 | `watchdog-state.json` 落盘（`lastNotified`/`prev`/`recovered`），构造时恢复 |
| evaluator 里按"报过就跳过"压制 ⇒ 问题从列表消失 ⇒ 被当成"恢复"，发出假好消息 | **去掉 evaluator 的压制**：问题还在就必须还在列表里；去重交给 service 的冷却 |
| 部署 = 重启 ⇒ 被当成崩溃循环 | 阈值 3 → **5 次/小时**；`failed` 类单独 6 小时冷却；部署后清开机记录 |

验证：清过之后连续两轮（02:17–02:19）**一条都没再发**；状态文件里 5 个 `failed:` 的冷却时间在案。

⚠️ 教训写进契约：**"看门狗自己变成噪声"是最容易犯的错** —— 判据再准，重发/假恢复也会让用户静音它。

## 遗留（不阻塞归档）

- 判据阈值现在只能改 `config.yml` 的 `watchdog` 段；要不要给她一个"别吵了"的静音指令，
  由 B 档（受限动作）一起定
- 那 5 个 `unknown` 任务（今晚的探针）每 6 小时会被再提一次 —— **要不要收尾成 `needs_review` 由用户定**

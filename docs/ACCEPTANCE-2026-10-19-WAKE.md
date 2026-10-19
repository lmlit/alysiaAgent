# 真机验收记录：异步唤醒闭环（2026-10-19）

> change：`wake-her-on-task-result`（`openspec/changes/wake-her-on-task-result/`）
> 环境：`root@<SERVER>` · 容器 `alysia-server`（热替换 dist）· 宿主 runner `alysia-task-runner`
> 基座：`http://<SERVER>:3389/`（本次**未改动**挂载与发布方式）
> 工作区：`/srv/alysia-runner/toys`（练手项目，用户授权范围内）

## 0. 部署与前置

| 项 | 值 |
|---|---|
| 备份 | `/root/alysia/backups/dist-20261019-200542/`（core-dist / server-dist / runner.mjs.bak / config / compose / env / runner.env） |
| 代码 | `docker cp` 热替换 `core/dist` + `server/dist`（重建容器会退回镜像旧码，顺序已写进部署脚本） |
| 配置 | `subagentWake{enabled, maxAutoRework:2, autoAccept:true, intervalMs:5000, turnTimeoutMs:180000}` |
| 令牌 | 新增 `ALYSIA_RUNNER_TOKEN`：容器 `.env` + compose 透传 + runner `EnvironmentFile`；**runner 的 `ALYSIA_WEBUI_TOKEN` 已注释掉** |
| 启动日志 | `[Config] subagentWake: enabled=true autoAccept=true maxAutoRework=2 interval=5000ms` / `[subagent-wake] 已启动` |

**令牌隔离实测**（用 runner 令牌直接打端点）：

```
GET  /api/project-tasks/window   -> 200
GET  /api/persona/prompt         -> 200
GET  /api/roles                  -> 403   （管理面）
GET  /api/life                   -> 403
DELETE /api/knowledge/x          -> 403
管理令牌 GET /api/roles          -> 200   （全权未变）
```

## 1. 正常完成：接单 → 执行 → 自动唤起 → 她验收 → 汇报

任务 `pt-1820ac60…`（`kind: action`，委托：做一个 `hello-wake.html` 并发布）。

```
20:08:21  created：pt-1820ac60…
20:08:24  被认领（revision 0，第 1 次）
20:08:34  → needs_review（工程会话 session-44dfc844…）· 已入队结果事件 pt-1820ac60…:r0:result
20:09:02  [subagent-wake] …:r0:result 已处理完：她说了 235 字 → <OWNER>
```

- 执行：`dsh --profile alysia --json` 用时 **10 秒**，产出 `hello-wake.html`，`publish_page` 返回 200。
- 唤醒：**她跑的是完整一轮主 Agent**（同一管线：人格 + 记忆 + 工具），约 4.8 秒。
- 她的决定：**自己验收**（`accepted_by = qq-official-1:private:private_…`，`accepted_at=20:08:57`），
  随后 `status=completed`、`notified_at=20:09:02`。
- 她发出的话（QQ 私聊实发）：
  > 轻月，给你递个小的——这回是真的上线地址，不是预览门牌： http://<SERVER>:3389/p/alysia-toys/hello-wake.html
  > 页面特别简单，一句话，一个按钮，点一下那句话会换掉。做它没别的意思

**这是库里第一条被验收的任务**（此前 31 条全部停在 `needs_review`）。

## 2. 受控返工 → 再验收 → 再汇报

操作员提意见（与工具走同一个 `addRevision`）：`页面太素了：把那句话换成一个会自己慢慢变的短句（三句轮换），按钮去掉。`

```
20:09:37  续作：pt-1820ac60… → revision 1（沿用工程会话 session-44dfc844…）
20:09:49  被认领（revision 1，第 2 次）
          [第 1 轮] dsh --profile alysia --json --session-id session-44dfc844… <task>   ← ★ 续接上了
20:10:01  → needs_review · 已入队 pt-1820ac60…:r1:result
20:10:24  [subagent-wake] …:r1:result 已处理完：她说了 286 字
```

- `original_goal` 与新的 `goal` 都在任务行里（原目标没被覆盖）。
- 同一 `dsh_session_id` 与第一轮一致 ⇒ **跨轮续接生效**（旧实现六阶段=六次独立会话）。
- 她再次验收（`accepted_at=20:10:18`），汇报里说明「按钮拿掉了 / 三句轮着来 / 每四秒多一点」——
  与反馈一致，地址仍是 `/p/alysia-toys/hello-wake.html`（200）。

## 3. 重启恢复：结果落库后进程重启，闭环继续

把 `subagentWake.intervalMs` 临时调到 **120000**（让队列不急着投递），重启容器，再建任务
`pt-402722f4…`（`restart-check.html`）：

```
20:11:11  → needs_review · 已入队结果事件 pt-402722f4…:r0:result
          DB: status=pending, attempts=0        ← 结果已可靠落库、尚未投递
20:11:59  重启完成：[subagent-wake] 结果事件队列现状：{"done":2,"pending":1}（重启后仍在库里的会继续投递）
20:12:14  她验收（accepted_at）
20:12:18  她的话：「轻月，那一页我去过、也认下了—— …/restart-check.html …」
20:12:23  notified_at 落定；事件 status=done
```

⇒ **待处理事件不依赖进程内存**；重启后自动继续投递，没有丢结果、没有重复消息。

## 4. 数据现状（本 change **未调整存量**）

```
tasks  by status: completed 2 / needs_review 31
events by status: done 3
```

- 31 条 `needs_review` 是本次之前就存在的存量，**一条都没动**（没有回填、没有批量收尾）。
- 新增的 3 条事件全部 `done`，`attempts=1`，`last_error=null`（无重试、无死信）。

## 5. 必测场景对照

| 场景 | 结果 | 证据 |
|---|---|---|
| 正常完成 | ✅ | §1：先接单（工具立刻返回）→ 后台执行 → 自动唤起 → 验收 → 汇报 |
| 执行期间继续聊天 | ✅ | 唤醒只占一轮 4.8s；QQ 连接全程在线（`READY`），未阻塞消息处理 |
| 回调重复 / 乱序 | ✅ | `event_id` 幂等 + `fromEventId` 返工幂等 + `accepted_at` 幂等（单测 20 例覆盖）；迟到的 `claimToken` 回传 409 |
| 落库后重启 | ✅ | §3 真机 |
| dsh 失败 / 超时 / 需要确认 | ✅（单测 + 逻辑）| 状态映射 `failed/unknown` 不虚报；唤醒输入里明确禁止说「做好了」；`evidence.fresh=false` 时同样禁止 |
| 中途改需求 / 取消 | ✅（机制）| 派发前核对 `revision`：过期结果只 ack 不唤醒（单测「任务已经进到第 2 轮 → 不唤起」）|
| QQ 发送失败 | ✅（单测）| `sendProactive` 返回 false / 抛错 ⇒ fail 退避重试，**不重跑 coding** |
| 旧截图/旧文件 | ✅ | 产物带 `mtime` + `roundStartedAt`；`fresh=false`（单测 4 例 + `/result` 路由例） |
| 自动返工到上限 | ✅（单测）| `maxAutoRework=2` 到顶：工具回「不再自动改了，跟用户说」，输入里也写明到上限 |

## 6. 页面可访问性

```
http://<SERVER>:3389/p/alysia-toys/hello-wake.html     -> 200
http://<SERVER>:3389/p/alysia-toys/restart-check.html  -> 200
```

地址全部来自执行侧（`publish_page` 自检 + runner 派生），服务端只做前缀校验，**没有硬编码生产 URL**。

## 7. 未覆盖 / 已知不足

1. **六阶段 `build` 任务未在本次真机跑**（只跑了 `action` 单轮）。跨阶段续接的代码路径已改，
   但"六轮都带同一个 session"只在逻辑与单测层面验证；建议下次挑一个 build 任务真跑一次。
2. `notified_at` 在"发出后、ack 前"崩溃的极小概率下会重复一条消息（契约 79 已记录）。
3. 唤醒只处理**新产生的终态**；存量 31 条不会自动补唤醒（需用户确认后另行处理）。
4. 派发是单实例进程内的（多实例部署需要租约）。


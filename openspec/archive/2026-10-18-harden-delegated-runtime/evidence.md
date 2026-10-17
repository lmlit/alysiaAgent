# 真机记录：harden-delegated-runtime（2026-10-17 / 18）

> 环境：生产 `<server>`（阿里云北京）。分两步脚本执行，每步当场验，不靠"应该没问题"。

## 1. 降权的核心断言（8/8 通过）

以 `alysia-runner` 身份 `test -r`：

```
✅ 拒绝：/root
✅ 拒绝：/root/alysia
✅ 拒绝：/root/alysia/data
✅ 拒绝：/root/alysia/data/alysia.db
✅ 拒绝：/root/alysia/.env
✅ 拒绝：/root/.dsh
✅ 拒绝：/root/.dsh/.credentials.yaml
✅ 拒绝：/root/alysia-dsh-adapter-0.1.0-b.tgz
```

对照：`/srv/alysia-runner/blog` **可写**、`/srv/alysia-runner/.dsh` 下 `dsh --profile alysia --dump-config` 正常。

⇒ **「删库 / 读 key / 改 .env / 翻别人的 dsh 历史」从"需要审批"变成"根本做不到"。**
这正是先做能力边界、再做审批的理由：审批层只需要处理"合理但需点头"的动作。

## 2. 纵深：屏障从一道变两道

| 项 | 改动前 | 改动后 | 备注 |
|---|---|---|---|
| `/root` | `dr-xr-x---`（750） | 未变 | 唯一屏障 |
| `/root/alysia/data` | `drwxrwxr-x` **775（other 可读）** | **750** | owner/group **不变**（容器内用户 1002），只去 other |
| `/root/alysia/.env` | `-rw-r--r--` **644（全局可读）** | **700** | — |

⚠️ **改完当场验容器**：`/api/health` ok、`Up (healthy)` —— 改数据目录权限必须立刻确认没把她的记忆库搞坏。

> 这一条值得记：`/root` 的 750 是唯一屏障，而 `data` 原本是 **775**、`.env` 是 **644**。
> 只要哪天有人把 `/root` 放开（或把工作区挪进 `/root` 下），凭据与整库就**直接可读**。
> 现在即使那样，也还有第二道。

## 3. 凭据

`/etc/alysia-runner.env`（`600 root:root`）含三个变量名：`DEEPSEEK_API_KEY` / `ALYSIA_WEBUI_TOKEN` / `ALYSIA_BASE_URL`。
runner 用户 `test -r` → **拒绝**。systemd 以 root 读该文件后再降权，所以进程里有、用户读不到。

## 4. 常驻 + 端到端（**全程没手工跑 runner**）

```
===== 建任务 =====  pt-70ad2b18-…（不碰 runner）
===== 等服务自己认领 =====
  t+  5s status=running
  t+ 10s status=running
  t+ 15s status=needs_review
===== 最终 =====  status=needs_review attempts=1
                  dshSessionId=session-380fcd84-…
                  result.final=HARDEN-OK
===== runner 日志 =====
  16:16:09 认领到 pt-70ad2b18-…（revision 0，第 1 次）
  16:16:09   将执行：dsh --profile alysia --json <task>
  16:16:09   工作区：/srv/alysia-runner/blog
  16:16:19   dsh 退出码 0，用时 10s，turn_end.reason=completed
  16:16:19   已回传：needs_review
===== 身份 =====  alysia-+ 142455 node …/project-task-runner.mjs
===== 工作区 =====  /srv/alysia-runner/blog（空、未改动）
===== 记忆标记 =====  dsh:session-380fcd84-… 3 条事件全部 skip_profile=True/synthetic=delegated-task；摘要 0
===== systemd =====  active，NRestarts=0
```

**顺带验证了一条失败路径**：容器重建期间 runner 收到 `认领失败（HTTP 500）` —— 它**没有退出**，
按 15s 间隔重试，随后正常认领。这正是"轮询异常不许让 runner 死掉"的设计意图。

## 5. 本次**未**验到的（诚实记录）

- **没能在运行中抓到 dsh 子进程的 uid**：`ps` 执行时那一轮已经跑完（10 秒太短）。
  从父进程身份（`alysia-runner`）与非 root 的事实可推断子进程同为该用户，但**没有直接证据**。
  （下次可在执行期间并发 `ps`，或用 `systemd-run --uid` 对照。）
- 出站网络未收窄（博客构建要拉 npm / 字体）——**目前她仍可出网**，只是读不到凭据与记忆库。
- 受限令牌（只许调 ingest / project-result）未做，进程里仍持有全权 token。
